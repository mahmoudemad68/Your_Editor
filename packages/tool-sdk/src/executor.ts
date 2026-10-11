import { applyCommand, parseCommand, type Timeline, type EditCommand } from "@editagent/domain";
import { randomBytes } from "node:crypto";
import { createUuidV7 } from "@editagent/domain";
import {
  ToolRegistry,
  type OwnedToolRun,
  type RegisteredTool,
  type ToolContext,
  type ToolResult,
  type ToolPermission,
} from "./registry.js";
import { ToolError, contentHash, jsonValue, safeErrorCode, checkedId } from "./validation.js";

export interface ToolCall {
  readonly name: string;
  readonly version: string;
  readonly callerId: string;
  readonly projectId: string;
  readonly resource: ToolContext["resource"];
  readonly input: unknown;
}
export interface ToolAuthority {
  authorize(
    call: Pick<ToolCall, "callerId" | "projectId" | "resource">,
    permissions: readonly ToolPermission[],
  ): Promise<void>;
  timeline(projectId: string, timelineId: string): Promise<Timeline>;
}
export type ExecutionOutcome =
  "running" | "succeeded" | "rejected" | "failed" | "cancelled" | "timed_out";
export interface ExecutionRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly callerId: string | null;
  readonly projectId: string | null;
  readonly toolName: string | null;
  readonly toolVersion: string | null;
  readonly inputHash: string | null;
  readonly startedAtMs: number;
  readonly finishedAtMs: number | null;
  readonly durationMs: number | null;
  readonly outcome: ExecutionOutcome;
  readonly code: string | null;
  readonly costMicros: number;
  readonly jobId: string | null;
}
export interface ToolAuditRepository {
  begin(record: ExecutionRecord): Promise<void>;
  /** Atomic per-project lifetime limit including concurrent reservations; trusted deployment config, never call payload. */
  reserve(id: string, projectId: string, costMicros: number): Promise<void>;
  finish(
    id: string,
    outcome: Exclude<ExecutionOutcome, "running">,
    code: string | null,
    costMicros: number,
  ): Promise<ExecutionRecord>;
  attachJob(id: string, jobId: string): Promise<void>;
  get(id: string): Promise<ExecutionRecord | null>;
  list(projectId: string, limit: number): Promise<readonly ExecutionRecord[]>;
}
export interface RemoteToolDispatcher {
  start(tool: RegisteredTool, input: unknown, context: ToolContext): Promise<OwnedToolRun>;
}
export interface ToolExecution {
  readonly record: ExecutionRecord;
  readonly output: unknown;
  readonly commands: readonly EditCommand[];
}
const idOrNull = (s: string): string | null => {
  try {
    return checkedId(s);
  } catch {
    return null;
  }
};
export class ToolExecutor {
  private active = 0;
  constructor(
    private readonly registry: ToolRegistry,
    private readonly authority: ToolAuthority,
    private readonly audit: ToolAuditRepository,
    private readonly remote?: RemoteToolDispatcher,
    private readonly maximumConcurrency = 4,
    private readonly onRecord?: (record: ExecutionRecord) => void | Promise<void>,
  ) {
    if (
      !Number.isSafeInteger(maximumConcurrency) ||
      maximumConcurrency < 1 ||
      maximumConcurrency > 32
    )
      throw new ToolError("invalid_concurrency");
  }
  async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolExecution> {
    const id = createUuidV7(Date.now(), randomBytes(10));
    let malformed = false;
    try {
      call = jsonValue(call) as ToolCall;
      if (!call || typeof call !== "object" || Array.isArray(call))
        throw new ToolError("invalid_call");
    } catch {
      malformed = true;
      call = {
        name: "",
        version: "",
        callerId: "",
        projectId: "",
        resource: { kind: "project", id: "" },
        input: null,
      };
    }
    let inputHash: string | null = null;
    try {
      if (!malformed) inputHash = contentHash(call.input);
    } catch {
      /* malformed inputs still receive a rejection record */
    }
    let registered: RegisteredTool | null = null;
    try {
      registered = this.registry.lookup(call.name, call.version);
    } catch {
      /* Unknown identifiers are not copied from caller text into the audit. */
    }
    await this.audit.begin({
      schemaVersion: 1,
      id,
      callerId: idOrNull(call.callerId),
      projectId: idOrNull(call.projectId),
      toolName: registered?.manifest.name ?? null,
      toolVersion: registered?.manifest.version ?? null,
      inputHash,
      startedAtMs: Date.now(),
      finishedAtMs: null,
      durationMs: null,
      outcome: "running",
      code: null,
      costMicros: 0,
      jobId: null,
    });
    const controller = new AbortController();
    const abort = () => controller.abort(new ToolError("cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let run: OwnedToolRun | undefined;
    let reserved = 0,
      admitted = false,
      occupied = false;
    try {
      if (malformed) throw new ToolError("invalid_call");
      if (Object.keys(call).sort().join() !== "callerId,input,name,projectId,resource,version")
        throw new ToolError("invalid_call");
      call = Object.freeze({
        ...call,
        resource: Object.freeze({ ...call.resource }),
        input: jsonValue(call.input),
      });
      checkedId(call.callerId);
      checkedId(call.projectId);
      checkedId(call.resource.id);
      if (
        !["project", "asset", "timeline"].includes(call.resource.kind) ||
        Object.keys(call.resource).sort().join() !== "id,kind"
      )
        throw new ToolError("denied");
      const tool = this.registry.lookup(call.name, call.version);
      timeout = setTimeout(
        () => controller.abort(new ToolError("timed_out")),
        tool.manifest.timeoutMs,
      );
      await withAbort(this.authority.authorize(call, tool.manifest.permissions), controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      const input = this.registry.validate(tool, "input", call.input);
      if (this.active >= this.maximumConcurrency) throw new ToolError("capacity_exceeded");
      this.active++;
      occupied = true;
      await this.audit.reserve(id, call.projectId, tool.manifest.maximumCostMicros);
      reserved = tool.manifest.maximumCostMicros;
      if (controller.signal.aborted) throw controller.signal.reason;
      admitted = true;
      const context: ToolContext = {
        executionId: id,
        callerId: call.callerId,
        projectId: call.projectId,
        resource: Object.freeze({ ...call.resource }),
        signal: controller.signal,
        progress: async () => undefined,
      };
      run =
        tool.binding.mode === "in-process"
          ? tool.binding.tool.start(input, context)
          : await this.remoteStart(tool, input, context);
      const result = await awaitOwned(run, controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      const output = this.registry.validate(tool, "output", result.output);
      if (
        !Number.isSafeInteger(result.costMicros) ||
        result.costMicros < 0 ||
        result.costMicros > reserved
      )
        throw new ToolError("invalid_cost");
      // Reauthorize before exposing results; proposals never commit a Timeline or overwrite media.
      await withAbort(this.authority.authorize(call, tool.manifest.permissions), controller.signal);
      const commands = await withAbort(
        validateCommands(tool, output, call, this.authority),
        controller.signal,
      );
      if (controller.signal.aborted) throw controller.signal.reason;
      const record = await this.audit.finish(id, "succeeded", null, result.costMicros);
      this.emit(record);
      return { record, output, commands };
    } catch (error) {
      if (run) await run.cancel(); // cleanup acknowledged before terminal audit state
      const code = controller.signal.aborted
        ? (controller.signal.reason as ToolError).code
        : error instanceof ToolError
          ? error.code
          : "execution_failed";
      const sanitized = safeErrorCode(code);
      const outcome =
        code === "cancelled"
          ? "cancelled"
          : code === "timed_out"
            ? "timed_out"
            : admitted
              ? "failed"
              : "rejected";
      const record = await this.audit.finish(id, outcome, sanitized, reserved);
      this.emit(record);
      throw new ToolError(
        sanitized,
        `Tool execution ${id}: ${sanitized}` +
          (!admitted && code === "invalid_input" && error instanceof ToolError
            ? `; ${error.message}`
            : ""),
      );
    } finally {
      if (occupied) this.active--;
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
  private emit(record: ExecutionRecord): void {
    try {
      void Promise.resolve(this.onRecord?.(record)).catch(() => undefined);
    } catch {
      /* Observational sink cannot alter persisted execution state. */
    }
  }
  private remoteStart(t: RegisteredTool, i: unknown, c: ToolContext): Promise<OwnedToolRun> {
    if (!this.remote) throw new ToolError("remote_unavailable");
    return this.remote.start(t, i, c);
  }
  /** Query requires a trusted authenticated caller. Own rejected attempts are visible; others require current project authority. */
  async record(callerId: string, executionId: string): Promise<ExecutionRecord | null> {
    checkedId(callerId);
    checkedId(executionId);
    const record = await this.audit.get(executionId);
    if (!record) return null;
    if (record.callerId !== callerId) {
      if (!record.projectId) throw new ToolError("denied");
      await this.authority.authorize(
        {
          callerId,
          projectId: record.projectId,
          resource: { kind: "project", id: record.projectId },
        },
        ["project.read"],
      );
    }
    return record;
  }
  async records(
    callerId: string,
    projectId: string,
    limit = 50,
  ): Promise<readonly ExecutionRecord[]> {
    checkedId(callerId);
    checkedId(projectId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new ToolError("invalid_query");
    await this.authority.authorize(
      { callerId, projectId, resource: { kind: "project", id: projectId } },
      ["project.read"],
    );
    return this.audit.list(projectId, limit);
  }
}
export async function validateCommands(
  tool: RegisteredTool,
  output: unknown,
  call: Pick<ToolCall, "callerId" | "projectId" | "resource">,
  authority: ToolAuthority,
): Promise<readonly EditCommand[]> {
  if (!tool.manifest.mutating) return [];
  if (call.resource.kind !== "timeline") throw new ToolError("invalid_subject");
  const value = jsonValue(output) as Record<string, unknown>;
  if (!Array.isArray(value.commands) || value.commands.length === 0 || value.commands.length > 100)
    throw new ToolError("invalid_commands");
  let timeline = await authority.timeline(call.projectId, call.resource.id);
  if (timeline.projectId !== call.projectId || timeline.id !== call.resource.id)
    throw new ToolError("invalid_subject");
  const commands: EditCommand[] = [];
  const ids = new Set<string>();
  for (const raw of value.commands) {
    const command = parseCommand(raw);
    if (command.timelineId !== timeline.id || ids.has(command.id))
      throw new ToolError("invalid_commands");
    if (command.type === "InsertClip" && command.payload.clip.sourceId) {
      await authority.authorize(
        {
          callerId: call.callerId,
          projectId: call.projectId,
          resource: { kind: "asset", id: command.payload.clip.sourceId },
        },
        ["project.read", "asset.read"],
      );
    }
    ids.add(command.id);
    timeline = applyCommand(timeline, command).timeline;
    commands.push(command);
  }
  return Object.freeze(commands);
}
export async function awaitOwned(run: OwnedToolRun, signal: AbortSignal): Promise<ToolResult> {
  let rejectAbort: (reason: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) onAbort();
    return await Promise.race([run.result, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let rejectAbort: (reason: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const abort = () => rejectAbort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) abort();
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

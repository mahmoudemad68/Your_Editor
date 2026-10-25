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
export type CleanupStatus = "not_required" | "succeeded" | "failed" | "unconfirmed";
export interface AuditSettlement {
  readonly finishedAtMs?: number;
  readonly cleanupStatus?: CleanupStatus;
  readonly costBasis?: "actual" | "reserved" | "none";
}
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
  readonly cleanupStatus: CleanupStatus;
  readonly cleanupCode: "cleanup_unconfirmed" | null;
  readonly stopCode: "cancelled" | "timed_out" | null;
  readonly costBasis: "actual" | "reserved" | "none";
}
export interface ToolAuditRepository {
  /** Atomic unique admission: an existing id MUST reject before any effect. */
  begin(record: ExecutionRecord, admission?: AdmissionLease): Promise<void>;
  /** Atomic per-project lifetime limit including concurrent reservations; trusted deployment config, never call payload. */
  reserve(id: string, projectId: string, costMicros: number, ownerId?: string): Promise<void>;
  finish(
    id: string,
    outcome: Exclude<ExecutionOutcome, "running">,
    code: string | null,
    costMicros: number,
    settlement?: AuditSettlement,
  ): Promise<ExecutionRecord>;
  attachJob(id: string, jobId: string, ownerId?: string): Promise<void>;
  recoverAdmissions(
    limit: number,
    executionId?: string,
    policies?: readonly AdmissionPolicy[],
  ): Promise<readonly ExecutionRecord[]>;
  noteCleanupFailure(id: string): Promise<void>;
  requestStop(id: string, code: "cancelled" | "timed_out"): Promise<void>;
  confirmCleanup(id: string, status: CleanupStatus): Promise<void>;
  pendingRemote(limit: number, executionId?: string): Promise<readonly ExecutionRecord[]>;
  get(id: string): Promise<ExecutionRecord | null>;
  list(projectId: string, limit: number): Promise<readonly ExecutionRecord[]>;
}
/** Non-renewable admission ownership lease: the logical execution deadline is its fence. */
export interface AdmissionLease {
  readonly ownerId: string;
  readonly deadlineAtMs: number;
  readonly mode: "remote" | "in-process" | "unknown";
}
export interface AdmissionPolicy {
  readonly name: string;
  readonly version: string;
  readonly timeoutMs: number;
  readonly mode: "remote" | "in-process";
}
export interface RemoteToolDispatcher {
  start(tool: RegisteredTool, input: unknown, context: ToolContext): Promise<OwnedToolRun>;
  reconcile(
    registry: ToolRegistry,
    limit: number,
    executionId?: string,
  ): Promise<readonly ExecutionRecord[]>;
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
/** Public query boundary deliberately drops exception messages/causes, which may contain credentials. */
const queryError = (error: unknown) =>
  new ToolError(error instanceof ToolError ? safeErrorCode(error.code) : "audit_recovery_failed");
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
    try {
      return await this.executeOwned(call, signal);
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError("audit_recovery_failed");
    }
  }
  /** Trusted durable coordinators persist this identity BEFORE calling. The audit
   * primary key admits it once; a duplicate/unknown outcome never reruns a tool.
   * This identity is deliberately not part of the public ToolCall input contract. */
  async executeWithIdentity(
    id: string,
    call: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolExecution> {
    try {
      checkedId(id);
      return await this.executeOwned(call, signal, id);
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError("audit_recovery_failed");
    }
  }
  private async executeOwned(
    call: ToolCall,
    signal?: AbortSignal,
    identity?: string,
  ): Promise<ToolExecution> {
    const id = identity ?? createUuidV7(Date.now(), randomBytes(10));
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
    const startedAtMs = Date.now();
    const ownerId = createUuidV7(startedAtMs, randomBytes(10));
    await this.audit.begin(
      {
        schemaVersion: 1,
        id,
        callerId: idOrNull(call.callerId),
        projectId: idOrNull(call.projectId),
        toolName: registered?.manifest.name ?? null,
        toolVersion: registered?.manifest.version ?? null,
        inputHash,
        startedAtMs,
        finishedAtMs: null,
        durationMs: null,
        outcome: "running",
        code: null,
        costMicros: 0,
        jobId: null,
        cleanupStatus: "not_required",
        cleanupCode: null,
        stopCode: null,
        costBasis: "none",
      },
      {
        ownerId,
        deadlineAtMs: startedAtMs + (registered?.manifest.timeoutMs ?? 2000),
        mode: registered?.binding.mode ?? "unknown",
      },
    );
    const controller = new AbortController();
    const abort = () => controller.abort(new ToolError("cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let run: OwnedToolRun | undefined;
    let inputDiagnostics: string | undefined;
    let cleanupStatus: CleanupStatus = "not_required";
    let cleanupAttempted = false;
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
        Math.max(0, startedAtMs + tool.manifest.timeoutMs - Date.now()),
      );
      await withAbort(this.recover(), controller.signal);
      await withAbort(this.authority.authorize(call, tool.manifest.permissions), controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      let input: unknown;
      try {
        input = this.registry.validate(tool, "input", call.input);
      } catch (error) {
        if (error instanceof ToolError && error.code === "invalid_input")
          inputDiagnostics = error.message;
        throw error;
      }
      if (this.active >= this.maximumConcurrency) throw new ToolError("capacity_exceeded");
      this.active++;
      occupied = true;
      await this.audit.reserve(id, call.projectId, tool.manifest.maximumCostMicros, ownerId);
      reserved = tool.manifest.maximumCostMicros;
      if (controller.signal.aborted) throw controller.signal.reason;
      admitted = true;
      const context: ToolContext = {
        executionId: id,
        admissionOwnerId: ownerId,
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
      cleanupAttempted = true;
      cleanupStatus = await cleanupOwned(run);
      if (cleanupStatus === "failed") throw new ToolError("cleanup_unconfirmed");
      if (controller.signal.aborted) throw controller.signal.reason;
      const record = await this.audit.finish(id, "succeeded", null, result.costMicros, {
        cleanupStatus,
        costBasis: "actual",
      });
      if (record.outcome !== "succeeded") throw new ToolError(record.code ?? "execution_failed");
      this.emit(record);
      return { record, output, commands };
    } catch (error) {
      const code = controller.signal.aborted
        ? (controller.signal.reason as ToolError).code
        : error instanceof ToolError
          ? error.code
          : "execution_failed";
      // Persist stop intent before cancellation: a crash cannot turn timeout into ordinary cancellation.
      if (code === "cancelled" || code === "timed_out") await this.audit.requestStop(id, code);
      if (run && !cleanupAttempted) cleanupStatus = await cleanupOwned(run);
      const sanitized = safeErrorCode(code);
      const outcome =
        code === "cancelled"
          ? "cancelled"
          : code === "timed_out"
            ? "timed_out"
            : admitted
              ? "failed"
              : "rejected";
      const record = await this.audit.finish(id, outcome, sanitized, reserved, {
        cleanupStatus,
        costBasis: reserved ? "reserved" : "none",
      });
      this.emit(record);
      throw new ToolError(
        sanitized,
        `Tool execution ${id}: ${sanitized}` +
          (!admitted && code === "invalid_input" && inputDiagnostics
            ? `; ${inputDiagnostics}`
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
  private admissionPolicies(): readonly AdmissionPolicy[] {
    return this.registry.discover().map((m) => ({
      name: m.name,
      version: m.version,
      timeoutMs: m.timeoutMs,
      mode: this.registry.lookup(m.name, m.version).binding.mode,
    }));
  }
  private remoteStart(t: RegisteredTool, i: unknown, c: ToolContext): Promise<OwnedToolRun> {
    if (!this.remote) throw new ToolError("remote_unavailable");
    return this.remote.start(t, i, c);
  }
  /** Startup/new admissions and authorized audit reads reconcile durable terminal remote jobs. */
  async recover(limit = 100): Promise<readonly ExecutionRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new ToolError("invalid_query");
    try {
      const admissions = await this.audit.recoverAdmissions(
        limit,
        undefined,
        this.admissionPolicies(),
      );
      return [...admissions, ...((await this.remote?.reconcile(this.registry, limit)) ?? [])];
    } catch {
      throw new ToolError("audit_recovery_failed");
    }
  }
  /** Historical ownership never substitutes for current project read authority. */
  async record(callerId: string, executionId: string): Promise<ExecutionRecord | null> {
    try {
      return await this.readRecord(callerId, executionId);
    } catch (error) {
      throw queryError(error);
    }
  }
  private async readRecord(callerId: string, executionId: string): Promise<ExecutionRecord | null> {
    checkedId(callerId);
    checkedId(executionId);
    const record = await this.audit.get(executionId);
    if (!record) return null;
    if (!record.projectId) throw new ToolError("denied");
    await this.readAuthority(callerId, record.projectId);
    await this.audit.recoverAdmissions(1, record.id, this.admissionPolicies());
    if (this.remote) {
      try {
        await this.remote.reconcile(this.registry, 1, record.id);
      } catch {
        throw new ToolError("audit_recovery_failed");
      }
    }
    await this.readAuthority(callerId, record.projectId);
    return this.audit.get(record.id);
  }
  async records(
    callerId: string,
    projectId: string,
    limit = 50,
  ): Promise<readonly ExecutionRecord[]> {
    try {
      checkedId(callerId);
      checkedId(projectId);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new ToolError("invalid_query");
      await this.readAuthority(callerId, projectId);
      await this.recover();
      await this.readAuthority(callerId, projectId);
      return await this.audit.list(projectId, limit);
    } catch (error) {
      throw queryError(error);
    }
  }
  private async readAuthority(callerId: string, projectId: string): Promise<void> {
    try {
      await this.authority.authorize(
        { callerId, projectId, resource: { kind: "project", id: projectId } },
        ["project.read"],
      );
    } catch {
      throw new ToolError("denied");
    }
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

export async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
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

/** Cleanup cannot replace an execution error or escape audit settlement. Escalation is owned and bounded. */
export async function cleanupOwned(run: OwnedToolRun): Promise<"succeeded" | "failed"> {
  const bounded = async (action: () => Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(action),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ToolError("cleanup_unconfirmed")), 5000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  try {
    await bounded(() => run.cancel());
    return "succeeded";
  } catch {
    try {
      await bounded(() => (run.forceStop ? run.forceStop() : run.cancel()));
      return "succeeded";
    } catch {
      return "failed";
    }
  }
}

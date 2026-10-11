import {
  jobId,
  projectId,
  type JobEnvelope,
  type JobQueue,
  type JobRepository,
  type JobSubject,
} from "@editagent/domain";
import {
  type ToolAuthority,
  type ToolAuditRepository,
  type RemoteToolDispatcher,
  validateCommands,
} from "./executor.js";
import {
  type ToolContext,
  type RegisteredTool,
  type OwnedToolRun,
  type ToolResult,
  ToolRegistry,
  type ITool,
} from "./registry.js";
import { ToolError, contentHash, jsonValue, safeErrorCode, checkedId } from "./validation.js";
export const TOOL_REMOTE_JOB_TYPE = "tool.execute.v1";
export const toolQueueName = (target: "media" | "ai" | "render") => `tools-${target}-v1`;
export interface RemoteCall {
  readonly executionId: string;
  readonly callerId: string;
  readonly projectId: string;
  readonly resource: ToolContext["resource"];
  readonly name: string;
  readonly version: string;
  readonly fingerprint: string;
  readonly input: unknown;
  readonly inputHash: string;
}
export interface RemoteCallStore {
  put(call: RemoteCall): Promise<void>;
  get(executionId: string): Promise<RemoteCall | null>;
  result(executionId: string): Promise<ToolResult | null>;
  complete(executionId: string, result: ToolResult): Promise<void>;
}
/** The composition root injects US-129 enqueueJob/cancelJob; this is not a second job state machine. */
export interface ToolJobLifecycle {
  enqueue(input: {
    id: string;
    queueName: string;
    jobType: string;
    idempotencyKey: string;
    payload: Readonly<Record<string, unknown>>;
    subject: JobSubject;
    timeoutMs: number;
    maxAttempts: number;
    backoffBaseMs: number;
  }): Promise<unknown>;
  cancel(id: string): Promise<void>;
}
export class QueueToolDispatcher implements RemoteToolDispatcher {
  constructor(
    private readonly jobs: JobRepository,
    private readonly lifecycle: ToolJobLifecycle,
    private readonly calls: RemoteCallStore,
    private readonly audit: ToolAuditRepository,
  ) {}
  async start(tool: RegisteredTool, input: unknown, context: ToolContext): Promise<OwnedToolRun> {
    if (tool.binding.mode !== "remote") throw new ToolError("invalid_binding");
    const call: RemoteCall = {
      executionId: context.executionId,
      callerId: context.callerId,
      projectId: context.projectId,
      resource: context.resource,
      name: tool.manifest.name,
      version: tool.manifest.version,
      fingerprint: tool.fingerprint,
      input: jsonValue(input),
      inputHash: contentHash(input),
    };
    await this.calls.put(call);
    await this.audit.attachJob(call.executionId, call.executionId);
    const id = call.executionId;
    // Job timeout is the same manifest budget. SDK cancellation asks the queue, then awaits durable owned-work cleanup.
    await this.lifecycle.enqueue({
      id,
      queueName: toolQueueName(tool.binding.target),
      jobType: TOOL_REMOTE_JOB_TYPE,
      idempotencyKey: `tool:${id}:${tool.fingerprint}`,
      payload: { schemaVersion: 1, executionId: id },
      subject: { kind: "project", projectId: projectId(call.projectId) },
      timeoutMs: tool.manifest.timeoutMs,
      maxAttempts: 3,
      backoffBaseMs: 50,
    });
    let stop: Promise<void> | undefined;
    const polling = new AbortController();
    const cancel = () => (stop ??= this.stop(id).finally(() => polling.abort()));
    const result = this.wait(id, polling.signal);
    return { result, cancel };
  }
  private async wait(id: string, signal: AbortSignal): Promise<ToolResult> {
    for (;;) {
      if (signal.aborted) throw new ToolError("cancelled");
      const job = await this.jobs.findById(jobId(id));
      if (!job) throw new ToolError("remote_missing");
      if (job.status === "Completed") {
        const result = await this.calls.result(id);
        if (!result) throw new ToolError("remote_result_missing");
        return result;
      }
      if (job.status === "Failed") throw new ToolError("remote_failed");
      if (job.status === "Cancelled") throw new ToolError("cancelled");
      await delay(25);
    }
  }
  private async stop(id: string): Promise<void> {
    await this.lifecycle.cancel(id);
    const until = performance.now() + 5000;
    for (;;) {
      const j = await this.jobs.findById(jobId(id));
      if (j && ["Completed", "Cancelled", "Failed"].includes(j.status)) return;
      if (performance.now() > until) throw new ToolError("cleanup_unconfirmed");
      await delay(25);
    }
  }
}
/** A worker registers only real local implementations. The queue payload cannot select a module/file/function. */
export class RemoteToolConsumer {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly authority: ToolAuthority,
    private readonly calls: RemoteCallStore,
    private readonly audit: ToolAuditRepository,
    private readonly queue: JobQueue,
    private readonly implementations: ReadonlyMap<string, ITool>,
    private readonly target: "media" | "ai" | "render",
  ) {}
  async handle(envelope: JobEnvelope, signal: AbortSignal): Promise<void> {
    if (
      envelope.jobType !== TOOL_REMOTE_JOB_TYPE ||
      envelope.queueName !== toolQueueName(this.target) ||
      envelope.subject.kind !== "project" ||
      Object.keys(envelope.payload).sort().join() !== "executionId,schemaVersion" ||
      envelope.payload.schemaVersion !== 1 ||
      envelope.payload.executionId !== envelope.jobId
    )
      throw new ToolError("invalid_remote_envelope");
    checkedId(envelope.jobId);
    const call = await this.calls.get(envelope.jobId),
      record = await this.audit.get(envelope.jobId);
    if (
      !call ||
      !record ||
      record.outcome !== "running" ||
      record.jobId !== envelope.jobId ||
      record.callerId !== call.callerId ||
      record.toolName !== call.name ||
      record.toolVersion !== call.version ||
      call.executionId !== envelope.jobId ||
      record.projectId !== call.projectId ||
      call.projectId !== envelope.subject.id ||
      record.inputHash !== call.inputHash ||
      call.inputHash !== contentHash(call.input)
    )
      throw new ToolError("remote_binding_mismatch");
    const tool = this.registry.lookup(call.name, call.version);
    if (
      tool.fingerprint !== call.fingerprint ||
      tool.binding.mode !== "remote" ||
      tool.binding.target !== this.target ||
      envelope.timeoutMs !== tool.manifest.timeoutMs
    )
      throw new ToolError("remote_binding_mismatch");
    await this.authority.authorize(call, tool.manifest.permissions);
    const input = this.registry.validate(tool, "input", call.input);
    if (signal.aborted || (await this.queue.isCancelRequested(envelope.jobId)))
      throw signal.reason ?? new ToolError("cancelled");
    // Uploaded/persisted result from a crash-before-ack may be reused only after all authority/identity checks.
    const previous = await this.calls.result(call.executionId);
    if (previous) {
      this.registry.validate(tool, "output", previous.output);
      await validateCommands(tool, previous.output, call, this.authority);
      if (
        !Number.isSafeInteger(previous.costMicros) ||
        previous.costMicros < 0 ||
        previous.costMicros > tool.manifest.maximumCostMicros
      )
        throw new ToolError("invalid_cost");
      return;
    }
    const impl = this.implementations.get(`${call.name}@${call.version}`);
    if (!impl) throw new ToolError("remote_implementation_unavailable");
    let last = 0;
    const context: ToolContext = {
      executionId: call.executionId,
      callerId: call.callerId,
      projectId: call.projectId,
      resource: call.resource,
      signal,
      progress: async (p) => {
        if (!Number.isFinite(p) || p < last || p > 100) throw new ToolError("invalid_progress");
        last = p;
        if (!signal.aborted)
          await this.queue.publishProgress(envelope.jobId, {
            stage: "validating",
            percentage: p,
            attempt: envelope.attempt,
          });
      },
    };
    const run = impl.start(input, context);
    const abort = () => {
      void run.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const result = await run.result;
      if (signal.aborted || (await this.queue.isCancelRequested(envelope.jobId)))
        throw signal.reason ?? new ToolError("cancelled");
      this.registry.validate(tool, "output", result.output);
      if (
        !Number.isSafeInteger(result.costMicros) ||
        result.costMicros < 0 ||
        result.costMicros > tool.manifest.maximumCostMicros
      )
        throw new ToolError("invalid_cost");
      await this.authority.authorize(call, tool.manifest.permissions);
      await validateCommands(tool, result.output, call, this.authority);
      if (signal.aborted || (await this.queue.isCancelRequested(envelope.jobId)))
        throw signal.reason ?? new ToolError("cancelled");
      await this.calls.complete(call.executionId, result);
      await context.progress(100);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      await run.cancel();
    }
  }
}
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Matches the US-129 JobSupervisor port structurally; fixed target registry replaces payload module resolution. */
export class RemoteToolSupervisor {
  constructor(
    private readonly consumer: RemoteToolConsumer,
    private readonly permanent: (code: string) => Error,
    private readonly cancelled: () => Error,
  ) {}
  async run(
    envelope: JobEnvelope,
    _handler: { readonly modulePath: string; readonly exportName: string },
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.consumer.handle(envelope, signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof ToolError) {
        if (error.code === "cancelled") throw this.cancelled();
        throw this.permanent(safeErrorCode(error.code));
      }
      throw new Error("remote_execution_failed", { cause: error });
    }
  }
}

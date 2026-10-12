import {
  jobId,
  projectId,
  type JobEnvelope,
  type JobQueue,
  type JobRepository,
  type JobSubject,
  type EnqueueJobCommand,
} from "@editagent/domain";
import {
  type ToolAuthority,
  type CleanupStatus,
  type ExecutionRecord,
  type ExecutionOutcome,
  awaitOwned,
  withAbort,
  cleanupOwned,
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
  /** Private acknowledgment is independent of audit-note persistence. Missing acknowledgment is unconfirmed. */
  cleanup(executionId: string): Promise<CleanupStatus>;
  noteCleanup(executionId: string, status: CleanupStatus): Promise<void>;
  fence(executionId: string): Promise<void>;
  claimPublications(limit: number, executionId?: string): Promise<readonly EnqueueJobCommand[]>;
  acknowledgePublication(executionId: string): Promise<void>;
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
    // Return owned work BEFORE I/O: admission, Redis publication and queue wait share the deadline.
    let stop: Promise<void> | undefined;
    const polling = new AbortController();
    const admission = (async () => {
      if (context.signal.aborted) throw context.signal.reason;
      await this.calls.put(call);
      await this.audit.attachJob(context.executionId, context.executionId);
      if (context.signal.aborted) throw context.signal.reason;
      await this.lifecycle.enqueue({
        id: context.executionId,
        queueName: toolQueueName(tool.binding.mode === "remote" ? tool.binding.target : "media"),
        jobType: TOOL_REMOTE_JOB_TYPE,
        idempotencyKey: `tool:${context.executionId}:${tool.fingerprint}`,
        payload: { schemaVersion: 1, executionId: context.executionId },
        subject: { kind: "project", projectId: projectId(call.projectId) },
        timeoutMs: tool.manifest.timeoutMs,
        maxAttempts: 3,
        backoffBaseMs: 50,
      });
      await this.calls.acknowledgePublication(context.executionId);
    })();
    const cancel = () => {
      stop ??= this.stop(context.executionId).finally(() => polling.abort());
      return stop;
    };
    const result = admission
      .catch(async (error: unknown) => {
        // Once admitted durably, publication is recoverable work, not a new transient execution attempt.
        if (context.signal.aborted) throw context.signal.reason;
        const job = await this.jobs.findById(jobId(context.executionId));
        if (!job) throw error;
      })
      .then(() => this.wait(context.executionId, polling.signal));
    return {
      result,
      cancel,
      forceStop: () => this.stop(context.executionId).finally(() => polling.abort()),
    };
  }

  /** Only terminal durable Jobs can settle abandoned audits. CAS settlement is safe across coordinators. */
  async reconcile(
    registry: ToolRegistry,
    limit: number,
    executionId?: string,
  ): Promise<readonly ExecutionRecord[]> {
    // Claims are leased; a killed coordinator cannot permanently own publication. Stable BullMQ IDs
    // make concurrent/late publication harmless. PostgreSQL and the consumer remain the execution fence.
    await this.publishPending(limit, executionId);
    const recovered: ExecutionRecord[] = [];
    for (const record of await this.audit.pendingRemote(limit, executionId)) {
      const job = await this.jobs.findById(jobId(record.jobId!));
      if (!job || !["Completed", "Failed", "Cancelled"].includes(job.status)) continue;
      let outcome: Exclude<ExecutionOutcome, "running"> =
        job.status === "Completed"
          ? "succeeded"
          : job.status === "Cancelled"
            ? "cancelled"
            : "failed";
      let code: string | null =
        job.status === "Completed"
          ? null
          : job.status === "Cancelled"
            ? "cancelled"
            : remoteFailureCode(job.failureReason);
      const call = await this.calls.get(record.id);
      // Read failures are infrastructure failures, not evidence of an invalid terminal outcome.
      const result = await this.calls.result(record.id);
      let cost = record.costMicros;
      // Reservation is exposure, not an invented actual charge when inference failed before a cost receipt.
      let basis: "actual" | "reserved" | "none" = "reserved";

      try {
        if (
          !call ||
          record.id !== job.id ||
          record.jobId !== job.id ||
          job.jobType !== TOOL_REMOTE_JOB_TYPE ||
          job.subject.kind !== "project" ||
          job.subject.projectId !== record.projectId ||
          call.executionId !== record.id ||
          call.projectId !== record.projectId ||
          call.callerId !== record.callerId ||
          call.name !== record.toolName ||
          call.version !== record.toolVersion ||
          call.inputHash !== record.inputHash ||
          contentHash(call.input) !== call.inputHash ||
          Object.keys(job.payload).sort().join() !== "executionId,schemaVersion" ||
          job.payload.executionId !== record.id ||
          job.payload.schemaVersion !== 1
        )
          throw new ToolError("remote_binding_mismatch");
        const tool = registry.lookup(call.name, call.version);
        if (
          tool.binding.mode !== "remote" ||
          toolQueueName(tool.binding.target) !== job.queueName ||
          tool.fingerprint !== call.fingerprint ||
          job.timeoutMs !== tool.manifest.timeoutMs ||
          job.idempotencyKey !== `tool:${record.id}:${tool.fingerprint}`
        )
          throw new ToolError("remote_binding_mismatch");
        registry.validate(tool, "input", call.input);
        cost = tool.manifest.maximumCostMicros;

        if (result) {
          registry.validate(tool, "output", result.output);
          if (
            !Number.isSafeInteger(result.costMicros) ||
            result.costMicros < 0 ||
            result.costMicros > cost
          )
            throw new ToolError("invalid_cost");
          cost = result.costMicros;
          basis = "actual";
        } else if (job.status === "Completed") throw new ToolError("remote_result_missing");
      } catch (error) {
        outcome = "failed";
        code = error instanceof ToolError ? safeErrorCode(error.code) : "remote_binding_mismatch";
      }
      if (
        (job.status === "Cancelled" || job.status === "Failed") &&
        (record.stopCode === "timed_out" ||
          ["timed out", "timed_out"].includes(job.failureReason ?? ""))
      ) {
        outcome = "timed_out";
        code = "timed_out";
      }
      const cleanupStatus = await this.calls.cleanup(record.id);
      if (record.outcome !== "running") {
        await this.audit.confirmCleanup(record.id, cleanupStatus);
        recovered.push((await this.audit.get(record.id))!);
        continue;
      }
      recovered.push(
        await this.audit.finish(record.id, outcome, code, cost, {
          finishedAtMs: Number(job.updatedAt),
          cleanupStatus,
          costBasis: basis,
        }),
      );
    }
    return recovered;
  }
  private async publishPending(limit: number, executionId?: string): Promise<void> {
    const publications = await this.calls.claimPublications(Math.min(limit, 4), executionId);
    await Promise.all(
      publications.map(async (command) => {
        try {
          await bounded(this.lifecycle.enqueue(command), 1000);
          await this.calls.acknowledgePublication(command.id);
        } catch {
          // Keep the durable intent. A reconnect/restart retries; never turn a transport outage into success.
        }
      }),
    );
  }
  private async wait(id: string, signal: AbortSignal): Promise<ToolResult> {
    let nextPublication = 0;
    for (;;) {
      if (signal.aborted) throw new ToolError("cancelled");
      const job = await this.jobs.findById(jobId(id));
      if (!job) throw new ToolError("remote_missing");
      if (job.status === "Completed") {
        const result = await this.calls.result(id);
        if (!result) throw new ToolError("remote_result_missing");
        return result;
      }
      if (job.status === "Failed") throw new ToolError(remoteFailureCode(job.failureReason));
      if (job.status === "Cancelled") throw new ToolError("cancelled");
      if (job.status === "Queued" && Date.now() >= nextPublication) {
        nextPublication = Date.now() + 1000;
        await this.publishPending(1, id);
      }
      await delay(25);
    }
  }
  private async stop(id: string): Promise<void> {
    // Fence queued admissions in PostgreSQL first. Redis may be paused or a pending add may finish late.
    await this.calls.fence(id);
    void bounded(this.lifecycle.cancel(id), 1000).catch(() => undefined);
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      const job = await this.jobs.findById(jobId(id));
      if (!job || ["Completed", "Failed", "Cancelled"].includes(job.status)) {
        const cleanup = await this.calls.cleanup(id);
        await this.audit.confirmCleanup(id, cleanup);
        if (cleanup === "failed" || cleanup === "unconfirmed")
          throw new ToolError("cleanup_unconfirmed");
        return;
      }
      await delay(25);
    }
    throw new ToolError("cleanup_unconfirmed");
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
    const record = await this.audit.get(envelope.jobId);
    if (!record) throw new ToolError("remote_binding_mismatch");
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const remaining = record.startedAtMs + envelope.timeoutMs - Date.now();
    const timer = setTimeout(
      () => controller.abort(new ToolError("timed_out")),
      Math.max(0, remaining),
    );
    if (remaining <= 0 || record.stopCode || record.outcome !== "running")
      controller.abort(new ToolError(record.stopCode ?? "timed_out"));
    let checking = false;
    const poll = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.audit
        .get(envelope.jobId)
        .then((current) => {
          if (!current || current.stopCode || current.outcome !== "running")
            controller.abort(new ToolError(current?.stopCode ?? "cancelled"));
        })
        .catch(() => controller.abort(new ToolError("remote_failed")))
        .finally(() => {
          checking = false;
        });
    }, 50);
    try {
      await this.handleOwned(envelope, controller.signal);
    } finally {
      clearTimeout(timer);
      clearInterval(poll);
      signal.removeEventListener("abort", abort);
    }
  }
  private async handleOwned(envelope: JobEnvelope, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
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
    if (signal.aborted || (await withAbort(this.queue.isCancelRequested(envelope.jobId), signal)))
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
          await withAbort(
            this.queue.publishProgress(envelope.jobId, {
              stage: "validating",
              percentage: p,
              attempt: envelope.attempt,
            }),
            signal,
          );
      },
    };
    await this.calls.noteCleanup(call.executionId, "unconfirmed");
    if (signal.aborted) throw signal.reason;
    const run = impl.start(input, context);
    let result: ToolResult | undefined;
    let failure: unknown;
    try {
      result = await awaitOwned(run, signal);
      if (signal.aborted || (await withAbort(this.queue.isCancelRequested(envelope.jobId), signal)))
        throw new ToolError("cancelled");
      this.registry.validate(tool, "output", result.output);
      if (
        !Number.isSafeInteger(result.costMicros) ||
        result.costMicros < 0 ||
        result.costMicros > tool.manifest.maximumCostMicros
      )
        throw new ToolError("invalid_cost");
      await this.authority.authorize(call, tool.manifest.permissions);
      await validateCommands(tool, result.output, call, this.authority);
    } catch (error) {
      failure = signal.aborted ? signal.reason : error;
    }
    const cleanup = await cleanupOwned(run);
    // Original execution outcome wins; cleanup is independently persisted, never a raw adapter exception.
    let acknowledged = false;
    try {
      await this.calls.noteCleanup(call.executionId, cleanup);
      acknowledged = true;
    } catch {
      // A persistence failure cannot replace the primary permanent validation error.
    }
    if (cleanup === "failed" || !acknowledged) {
      try {
        if (acknowledged) await this.audit.noteCleanupFailure(call.executionId);
      } catch {
        /* Private receipt remains authoritative. */
      }
      if (!failure) failure = new ToolError("cleanup_unconfirmed");
    }
    if (failure) {
      if (failure === signal.reason && signal.aborted) throw failure;
      if (failure instanceof ToolError) throw new ToolError(safeErrorCode(failure.code));
      throw remoteExecutionError();
    }
    if (signal.aborted || (await withAbort(this.queue.isCancelRequested(envelope.jobId), signal)))
      throw signal.reason ?? new ToolError("cancelled");
    await this.calls.complete(call.executionId, result!);
    await context.progress(100);
  }
}
// Transport boundaries must not attach raw adapter errors as public Error.cause.
const remoteExecutionError = () => new Error("remote_execution_failed");
const remoteFailureCode = (reason: string | null) =>
  reason === "timed out"
    ? "timed_out"
    : safeErrorCode(reason) === "execution_failed"
      ? "remote_failed"
      : safeErrorCode(reason);
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ToolError("remote_unavailable")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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
      throw remoteExecutionError();
    }
  }
}

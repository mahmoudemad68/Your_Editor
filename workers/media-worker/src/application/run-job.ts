/**
 * Moves a reserved queue message through the Job aggregate.
 * This use case depends on ports. It does not import BullMQ or Redis.
 */

import {
  type Instant,
  Job,
  JobAttempt,
  type JobEnvelope,
  type JobQueue,
  type JobReceipt,
  type JobRepository,
  type JobSubject,
  jobId,
} from "@editagent/domain";

import {
  IdempotencyConflictError,
  InvalidJobEnvelopeError,
  JobCancelledError,
  JobExecutionUnconfirmedError,
  JobTimeoutError,
  LockLostError,
  PermanentJobError,
} from "./job-errors.js";
import { type IsolatedHandler, type JobSupervisor } from "./job-supervisor.js";

export type { IsolatedHandler, JobSupervisor } from "./job-supervisor.js";

export interface RunJobDeps {
  readonly jobs: JobRepository;
  readonly queue: JobQueue;
  readonly supervisor: JobSupervisor;
  readonly now: () => Instant;
  readonly newAttemptId: () => string;
}

const CANCEL_POLL_MS = 50;

export async function enqueueJob(
  deps: RunJobDeps,
  input: {
    readonly id: string;
    readonly queueName: string;
    readonly jobType: string;
    readonly idempotencyKey: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly subject: JobSubject;
    readonly timeoutMs: number;
    readonly maxAttempts: number;
    readonly backoffBaseMs: number;
  },
): Promise<{ jobId: string; duplicate: boolean }> {
  const existing = await deps.jobs.findByIdempotencyKey(input.idempotencyKey);
  if (existing) {
    await republishQueued(deps, existing, input);
    return { jobId: existing.id, duplicate: true };
  }
  const job = Job.create(jobId(input.id), input.subject, deps.now(), {
    queueName: input.queueName,
    jobType: input.jobType,
    idempotencyKey: input.idempotencyKey,
    timeoutMs: input.timeoutMs,
    maxAttempts: input.maxAttempts,
    payload: input.payload,
  });
  try {
    await deps.jobs.save(job);
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    const winner = await deps.jobs.findByIdempotencyKey(input.idempotencyKey);
    if (winner) {
      await republishQueued(deps, winner, input);
      return { jobId: winner.id, duplicate: true };
    }
    throw error;
  }
  await deps.queue.enqueue({
    id: job.id,
    queueName: input.queueName,
    jobType: input.jobType,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
    subject: input.subject,
    timeoutMs: input.timeoutMs,
    maxAttempts: input.maxAttempts,
    backoffBaseMs: input.backoffBaseMs,
  });
  return { jobId: job.id, duplicate: false };
}

export async function cancelJob(deps: RunJobDeps, id: string): Promise<void> {
  await deps.queue.requestCancel(id);
  const job = await deps.jobs.findById(jobId(id));
  if (!job) {
    return;
  }
  if (job.status !== "Queued" && job.status !== "Retrying") {
    return;
  }
  const cancelled = job.cancel(deps.now());
  await deps.jobs.save(cancelled);
  if (job.queueName) {
    await deps.queue.discardQueued(id, job.queueName);
  }
}

export async function runNextJob(
  deps: RunJobDeps,
  queueName: string,
  handler: IsolatedHandler,
): Promise<"idle" | "done"> {
  let reserved;
  try {
    reserved = await deps.queue.reserve(queueName);
  } catch (error) {
    if (error instanceof InvalidJobEnvelopeError) {
      await persistInvalidEnvelope(deps, error.jobId);
      return "done";
    }
    throw error;
  }
  if (!reserved) {
    return "idle";
  }
  const controller = new AbortController();
  deps.queue.whenLockLost(reserved.receipt, () => {
    controller.abort(new LockLostError());
  });
  if (controller.signal.aborted) {
    return "done";
  }
  const current = await deps.jobs.findById(jobId(reserved.envelope.jobId));
  if (controller.signal.aborted) {
    return "done";
  }
  if (!current) {
    await deps.queue.fail(reserved.receipt, {
      reason: "job row is missing",
      transient: false,
    });
    return "done";
  }
  let cancelRequested: boolean;
  try {
    cancelRequested =
      current.status === "Cancelled" || (await deps.queue.isCancelRequested(current.id));
  } catch {
    if (!controller.signal.aborted) {
      await deps.queue.release(reserved.receipt);
    }
    return "done";
  }
  if (controller.signal.aborted) {
    return "done";
  }
  if (cancelRequested) {
    if (current.status !== "Cancelled") {
      await deps.jobs.save(current.cancel(deps.now()));
    }
    await deps.queue.complete(reserved.receipt);
    return "done";
  }
  if (current.status === "Completed" || current.status === "Failed") {
    await acknowledgeTerminal(deps, current, reserved.receipt, controller.signal);
    return "done";
  }
  const workable = await recoverAbandonedRun(deps, current, reserved.receipt, reserved.envelope);
  if (workable == null || controller.signal.aborted) {
    return "done";
  }
  const started = workable.start(deps.now());
  await deps.jobs.save(started);
  if (controller.signal.aborted) {
    return "done";
  }
  const attempt = JobAttempt.start(
    deps.newAttemptId(),
    started.id,
    started.attemptCount,
    started.updatedAt,
  );
  await deps.jobs.appendAttempt(attempt);
  if (controller.signal.aborted) {
    return "done";
  }
  let handlerFinished = false;
  const timeout = setTimeout(() => {
    if (!handlerFinished) {
      controller.abort(new JobTimeoutError());
    }
  }, reserved.envelope.timeoutMs);
  const cancelPoll = setInterval(() => {
    void Promise.resolve(deps.queue.isCancelRequested(started.id))
      .then((cancelled) => {
        if (handlerFinished || !cancelled) {
          return;
        }
        controller.abort(new JobCancelledError());
      })
      .catch(() => {
        // Redis did not answer the cancel poll. That is not a cancellation,
        // and the rejection must not escape the interval callback.
      });
  }, CANCEL_POLL_MS);
  try {
    await deps.supervisor.run(reserved.envelope, handler, controller.signal);
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }
  } catch (error) {
    await settleFailure(deps, started, attempt, reserved.receipt, reserved.envelope, error);
    return "done";
  } finally {
    handlerFinished = true;
    clearTimers(timeout, cancelPoll);
  }
  // The handler already succeeded. Ledger and acknowledgement failures stay
  // here, so they are not recorded as another handler attempt. A crash or
  // lock loss before this commit can run the handler again; external side
  // effects are not exactly-once. A commit followed by a lost acknowledgement
  // is reconciled by the next reservation.
  const committed = await commitCompletion(deps, started, attempt, reserved.receipt, controller);
  if (committed === "exhausted") {
    try {
      await deps.queue.release(reserved.receipt);
    } catch {
      // The reservation is already gone. Stall recovery can take the job.
    }
    return "done";
  }
  if (committed !== "committed" || controller.signal.aborted) {
    return "done";
  }
  if (!(await deps.queue.ownsReservation(reserved.receipt))) {
    return "done";
  }
  try {
    await deps.queue.complete(reserved.receipt);
  } catch {
    // PostgreSQL already committed. The next worker acknowledges the row.
  }
  return "done";
}

async function republishQueued(
  deps: RunJobDeps,
  stored: Job,
  input: {
    readonly queueName: string;
    readonly jobType: string;
    readonly idempotencyKey: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly subject: JobSubject;
    readonly timeoutMs: number;
    readonly maxAttempts: number;
    readonly backoffBaseMs: number;
  },
): Promise<void> {
  if (!sameStoredWork(stored, input)) {
    throw new IdempotencyConflictError();
  }
  if (stored.status !== "Queued") {
    return;
  }
  if (
    stored.queueName == null ||
    stored.jobType == null ||
    stored.idempotencyKey == null ||
    stored.timeoutMs == null ||
    stored.maxAttempts == null
  ) {
    throw new IdempotencyConflictError();
  }
  await deps.queue.enqueue({
    id: stored.id,
    queueName: stored.queueName,
    jobType: stored.jobType,
    idempotencyKey: stored.idempotencyKey,
    payload: stored.payload,
    subject: stored.subject,
    timeoutMs: stored.timeoutMs,
    maxAttempts: stored.maxAttempts,
    backoffBaseMs: input.backoffBaseMs,
  });
}

function sameStoredWork(
  stored: Job,
  input: {
    readonly queueName: string;
    readonly jobType: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly subject: JobSubject;
    readonly timeoutMs: number;
    readonly maxAttempts: number;
  },
): boolean {
  return (
    stored.queueName === input.queueName &&
    stored.jobType === input.jobType &&
    stored.timeoutMs === input.timeoutMs &&
    stored.maxAttempts === input.maxAttempts &&
    sameSubject(stored.subject, input.subject) &&
    canonicalJson(stored.payload) === canonicalJson(input.payload)
  );
}

function sameSubject(stored: JobSubject, input: JobSubject): boolean {
  if (stored.kind !== input.kind) {
    return false;
  }
  if (stored.kind === "project" && input.kind === "project") {
    return stored.projectId === input.projectId;
  }
  if (stored.kind === "media-asset" && input.kind === "media-asset") {
    return stored.mediaAssetId === input.mediaAssetId;
  }
  if (stored.kind === "derived-asset" && input.kind === "derived-asset") {
    return stored.derivedAssetId === input.derivedAssetId;
  }
  return false;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

async function persistInvalidEnvelope(deps: RunJobDeps, id: string): Promise<void> {
  const current = await deps.jobs.findById(jobId(id));
  if (
    !current ||
    current.status === "Completed" ||
    current.status === "Failed" ||
    current.status === "Cancelled"
  ) {
    return;
  }
  const at = deps.now();
  const reason = "Job envelope does not match the shared JSON Schema.";
  const running = current.status === "Running" ? current : current.start(at);
  if (running !== current) {
    await deps.jobs.save(running);
  }
  const failedAt = running === current ? at : deps.now();
  const failed = running.fail(failedAt, reason);
  await deps.jobs.save(failed);
  await deps.jobs.appendAttempt(
    JobAttempt.start(deps.newAttemptId(), failed.id, failed.attemptCount, failedAt).finish(
      "Failed",
      failedAt,
      reason,
    ),
  );
  await deps.jobs.saveDeadLetter({
    jobId: failed.id,
    reason,
    envelopeJson: JSON.stringify({ schemaVersion: 1, jobId: failed.id, invalid: true }),
    createdAt: failedAt,
  });
}

const WORKER_FAILED = "worker failed";

async function recoverAbandonedRun(
  deps: RunJobDeps,
  current: Job,
  receipt: JobReceipt,
  envelope: JobEnvelope,
): Promise<Job | null> {
  if (current.status !== "Running") {
    return current;
  }
  const at = deps.now();
  const attempts = await deps.jobs.listAttempts(current.id);
  const open = [...attempts].reverse().find((attempt) => attempt.finishedAt == null);
  const maxAttempts = current.maxAttempts ?? envelope.maxAttempts;
  if (current.attemptCount >= maxAttempts) {
    const failed = current.fail(at, WORKER_FAILED);
    await deps.jobs.save(failed);
    if (open) {
      await deps.jobs.appendAttempt(open.finish("Failed", at, WORKER_FAILED));
    }
    await deps.jobs.saveDeadLetter({
      jobId: failed.id,
      reason: WORKER_FAILED,
      envelopeJson: JSON.stringify(envelope),
      createdAt: at,
    });
    await deps.queue.fail(receipt, { reason: WORKER_FAILED, transient: false });
    return null;
  }
  const retrying = current.retry(at, WORKER_FAILED);
  await deps.jobs.save(retrying);
  if (open) {
    await deps.jobs.appendAttempt(open.finish("Retrying", at, WORKER_FAILED));
  }
  return retrying;
}

async function settleFailure(
  deps: RunJobDeps,
  started: Job,
  attempt: JobAttempt,
  receipt: JobReceipt,
  envelope: JobEnvelope,
  error: unknown,
): Promise<void> {
  if (error instanceof LockLostError || error instanceof JobExecutionUnconfirmedError) {
    return;
  }
  const at = deps.now();
  if (isCancelled(error)) {
    await deps.jobs.save(started.cancel(at));
    await deps.jobs.appendAttempt(attempt.finish("Cancelled", at, "cancelled"));
    await deps.queue.complete(receipt);
    return;
  }
  const reason = error instanceof Error ? error.message : "job failed";
  const permanent = error instanceof PermanentJobError;
  const attemptsLeft = envelope.attempt < envelope.maxAttempts;
  if (!permanent && attemptsLeft) {
    await deps.jobs.save(started.retry(at, reason));
    await deps.jobs.appendAttempt(attempt.finish("Retrying", at, reason));
    await deps.queue.fail(receipt, { reason, transient: true });
    return;
  }
  const failed = started.fail(at, reason);
  await deps.jobs.save(failed);
  await deps.jobs.appendAttempt(attempt.finish("Failed", at, reason));
  await deps.jobs.saveDeadLetter({
    jobId: failed.id,
    reason,
    envelopeJson: JSON.stringify(envelope),
    createdAt: at,
  });
  await deps.queue.fail(receipt, { reason, transient: false });
}

function isCancelled(error: unknown): boolean {
  return error instanceof JobCancelledError;
}

const LEDGER_RETRY_MS = 25;
const LEDGER_ATTEMPTS = 40;

async function commitCompletion(
  deps: RunJobDeps,
  started: Job,
  attempt: JobAttempt,
  receipt: JobReceipt,
  controller: AbortController,
): Promise<"committed" | "lock-lost" | "exhausted"> {
  const finishedAt = deps.now();
  const completed = started.complete(finishedAt);
  const closed = attempt.finish("Completed", finishedAt, null);
  for (let tryNumber = 0; tryNumber < LEDGER_ATTEMPTS; tryNumber += 1) {
    if (controller.signal.aborted) {
      return "lock-lost";
    }
    if (!(await deps.queue.ownsReservation(receipt))) {
      return "lock-lost";
    }
    try {
      await deps.jobs.recordCompletion(completed, closed);
      return "committed";
    } catch {
      if (controller.signal.aborted) {
        return "lock-lost";
      }
      await delay(LEDGER_RETRY_MS);
    }
  }
  return "exhausted";
}

async function acknowledgeTerminal(
  deps: RunJobDeps,
  job: Job,
  receipt: JobReceipt,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || !(await deps.queue.ownsReservation(receipt))) {
    return;
  }
  await closeOpenAttempt(deps, job);
  if (signal.aborted || !(await deps.queue.ownsReservation(receipt))) {
    return;
  }
  try {
    await deps.queue.complete(receipt);
  } catch {
    // The terminal row is already durable. The next reservation acknowledges it.
  }
}

async function closeOpenAttempt(deps: RunJobDeps, job: Job): Promise<void> {
  const attempts = await deps.jobs.listAttempts(job.id);
  const open = [...attempts].reverse().find((attempt) => attempt.finishedAt == null);
  if (!open) {
    return;
  }
  const now = deps.now();
  const at = now < open.startedAt ? open.startedAt : now;
  const status = job.status === "Failed" ? "Failed" : "Completed";
  await deps.jobs.appendAttempt(open.finish(status, at, job.failureReason));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function clearTimers(
  timeout: ReturnType<typeof setTimeout>,
  cancelPoll: ReturnType<typeof setInterval>,
): void {
  clearTimeout(timeout);
  clearInterval(cancelPoll);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

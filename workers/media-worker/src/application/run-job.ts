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
    if (existing.status === "Queued") {
      await publishQueued(deps, existing.id, input);
    }
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
      if (winner.status === "Queued") {
        await publishQueued(deps, winner.id, input);
      }
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
  const current = await deps.jobs.findById(jobId(reserved.envelope.jobId));
  if (!current) {
    await deps.queue.fail(reserved.receipt, {
      reason: "job row is missing",
      transient: false,
    });
    return "done";
  }
  if (current.status === "Cancelled" || (await deps.queue.isCancelRequested(current.id))) {
    if (current.status !== "Cancelled") {
      await deps.jobs.save(current.cancel(deps.now()));
    }
    await deps.queue.complete(reserved.receipt);
    return "done";
  }
  if (current.status === "Completed" || current.status === "Failed") {
    await deps.queue.complete(reserved.receipt);
    return "done";
  }
  const workable = await recoverAbandonedRun(deps, current, reserved.receipt, reserved.envelope);
  if (workable == null) {
    return "done";
  }
  const started = workable.start(deps.now());
  await deps.jobs.save(started);
  const attempt = JobAttempt.start(
    deps.newAttemptId(),
    started.id,
    started.attemptCount,
    started.updatedAt,
  );
  await deps.jobs.appendAttempt(attempt);
  const controller = new AbortController();
  let stopped = false;
  const timeout = setTimeout(() => {
    if (!stopped) {
      controller.abort(new JobTimeoutError());
    }
  }, reserved.envelope.timeoutMs);
  const cancelPoll = setInterval(() => {
    void Promise.resolve(deps.queue.isCancelRequested(started.id))
      .then((cancelled) => {
        if (stopped || !cancelled) {
          return;
        }
        controller.abort(new JobCancelledError());
      })
      .catch(() => {
        // Redis did not answer the cancel poll. That is not a cancellation,
        // and the rejection must not escape the interval callback.
      });
  }, CANCEL_POLL_MS);
  deps.queue.whenLockLost(reserved.receipt, () => {
    if (!stopped) {
      controller.abort(new LockLostError());
    }
  });
  try {
    await deps.supervisor.run(reserved.envelope, handler, controller.signal);
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }
    const finishedAt = deps.now();
    await deps.jobs.save(started.complete(finishedAt));
    await deps.jobs.appendAttempt(attempt.finish("Completed", finishedAt, null));
    await deps.queue.complete(reserved.receipt);
    return "done";
  } catch (error) {
    await settleFailure(deps, started, attempt, reserved.receipt, reserved.envelope, error);
    return "done";
  } finally {
    stopped = true;
    clearTimers(timeout, cancelPoll);
  }
}

async function publishQueued(
  deps: RunJobDeps,
  id: string,
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
  await deps.queue.enqueue({
    id: jobId(id),
    queueName: input.queueName,
    jobType: input.jobType,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
    subject: input.subject,
    timeoutMs: input.timeoutMs,
    maxAttempts: input.maxAttempts,
    backoffBaseMs: input.backoffBaseMs,
  });
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

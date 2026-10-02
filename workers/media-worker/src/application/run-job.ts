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

import { JobCancelledError, JobTimeoutError, PermanentJobError } from "./job-errors.js";

export type JobHandler = (envelope: JobEnvelope, signal: AbortSignal) => Promise<void>;

export interface RunJobDeps {
  readonly jobs: JobRepository;
  readonly queue: JobQueue;
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
      await deps.queue.enqueue({
        id: existing.id,
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
  handler: JobHandler,
): Promise<"idle" | "done"> {
  const reserved = await deps.queue.reserve(queueName);
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
  const timeout = setTimeout(() => {
    controller.abort(new JobTimeoutError());
  }, reserved.envelope.timeoutMs);
  const cancelPoll = setInterval(() => {
    void deps.queue.isCancelRequested(started.id).then((cancelled) => {
      if (cancelled) {
        controller.abort(new JobCancelledError());
      }
    });
  }, CANCEL_POLL_MS);
  try {
    await Promise.race([
      handler(reserved.envelope, controller.signal),
      abortAsPromise(controller.signal),
    ]);
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }
    clearTimers(timeout, cancelPoll);
    const finishedAt = deps.now();
    await deps.jobs.save(started.complete(finishedAt));
    await deps.jobs.appendAttempt(attempt.finish("Completed", finishedAt, null));
    await deps.queue.complete(reserved.receipt);
    return "done";
  } catch (error) {
    clearTimers(timeout, cancelPoll);
    await settleFailure(deps, started, attempt, reserved.receipt, reserved.envelope, error);
    return "done";
  }
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

function abortAsPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
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

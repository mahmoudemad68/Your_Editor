/** A handler failure that must not be retried. */
export class PermanentJobError extends Error {
  readonly permanent = true;

  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

/** The job exceeded its timeout. The coordinator decides whether an attempt remains. */
export class JobTimeoutError extends Error {
  constructor() {
    super("timed out");
    this.name = "JobTimeoutError";
  }
}

/** Cooperative cancellation won the race with the handler. */
export class JobCancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "JobCancelledError";
  }
}

/** This worker no longer owns the BullMQ lock. Do not acknowledge the job. */
export class LockLostError extends Error {
  constructor() {
    super("lock lost");
    this.name = "LockLostError";
  }
}

/** The supervised process could not be reaped. Terminal status must not be stored. */
export class JobExecutionUnconfirmedError extends Error {
  constructor() {
    super("execution did not stop");
    this.name = "JobExecutionUnconfirmedError";
  }
}

/** The idempotency key already names a job with different work. */
export class IdempotencyConflictError extends Error {
  constructor() {
    super("idempotency key is already stored with different work");
    this.name = "IdempotencyConflictError";
  }
}

/** The reserved BullMQ payload does not match the shared envelope. The queue job is already settled. */
export class InvalidJobEnvelopeError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super("Job envelope does not match the shared JSON Schema.");
    this.name = "InvalidJobEnvelopeError";
    this.jobId = jobId;
  }
}

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

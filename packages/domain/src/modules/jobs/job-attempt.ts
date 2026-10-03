/**
 * One execution of a Job. History is append-only.
 * The attempt does not change the Job; the aggregate transition does that.
 */

import { type Instant, instant, requireAuditOrder } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import { type JobId, jobId, uuidV7, type UuidV7 } from "../../kernel/id.js";
import { type JobStatus, jobStatus } from "./job.js";

export interface JobAttemptSnapshot {
  readonly id: string;
  readonly jobId: string;
  readonly attemptNumber: number;
  readonly status: string;
  readonly startedAt: bigint | string;
  readonly finishedAt: bigint | string | null;
  readonly reason: string | null;
}

export class JobAttempt {
  readonly id: UuidV7;
  readonly jobId: JobId;
  readonly attemptNumber: number;
  readonly status: JobStatus;
  readonly startedAt: Instant;
  readonly finishedAt: Instant | null;
  readonly reason: string | null;

  constructor(
    id: string,
    job: string,
    attemptNumber: number,
    status: string,
    startedAt: Instant | string | bigint,
    finishedAt: Instant | string | bigint | null,
    reason: string | null,
  ) {
    if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
      throw new DomainError("Job attemptNumber must be a positive integer.");
    }
    const started = instant(startedAt);
    const finished = finishedAt == null ? null : instant(finishedAt);
    if (finished != null) {
      requireAuditOrder(started, finished);
    }
    this.id = uuidV7(id);
    this.jobId = jobId(job);
    this.attemptNumber = attemptNumber;
    this.status = jobStatus(status);
    this.startedAt = started;
    this.finishedAt = finished;
    this.reason = reason == null || reason.trim().length === 0 ? null : reason.trim();
    Object.freeze(this);
  }

  static start(id: string, job: string, attemptNumber: number, startedAt: Instant): JobAttempt {
    return new JobAttempt(id, job, attemptNumber, "Running", startedAt, null, null);
  }

  finish(status: JobStatus, at: Instant, reason: string | null): JobAttempt {
    return new JobAttempt(
      this.id,
      this.jobId,
      this.attemptNumber,
      status,
      this.startedAt,
      at,
      reason,
    );
  }

  toSnapshot(): JobAttemptSnapshot {
    return {
      id: this.id,
      jobId: this.jobId,
      attemptNumber: this.attemptNumber,
      status: this.status,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      reason: this.reason,
    };
  }
}

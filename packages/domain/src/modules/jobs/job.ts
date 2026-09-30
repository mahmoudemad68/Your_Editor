/**
 * Job aggregate. Jobs owns the job record. The module that does the work owns the result.
 * The queue, retries, and workers are US-129. This type does not consume a queue.
 */

import { type Instant, instant } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import {
  type DerivedAssetId,
  type JobId,
  type MediaAssetId,
  type ProjectId,
} from "../../kernel/id.js";

/** State names from the job state machine. Transitions are US-129. */
export type JobStatus = "Queued" | "Running" | "Completed" | "Failed" | "Retrying" | "Cancelled";

/**
 * Points at the domain work the job executes.
 * It does not embed another module's aggregate.
 */
export type JobSubject =
  | { readonly kind: "project"; readonly projectId: ProjectId }
  | { readonly kind: "media-asset"; readonly mediaAssetId: MediaAssetId }
  | { readonly kind: "derived-asset"; readonly derivedAssetId: DerivedAssetId };

export class Job {
  readonly id: JobId;
  readonly subject: JobSubject;
  readonly status: JobStatus;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;

  private constructor(id: JobId, subject: JobSubject, status: JobStatus, createdAt: Instant) {
    this.id = id;
    this.subject = subject;
    this.status = status;
    this.createdAt = createdAt;
    this.updatedAt = createdAt;
  }

  static create(id: JobId, subject: JobSubject, createdAt: Instant): Job {
    return new Job(id, subject, "Queued", instant(createdAt));
  }
}

export function jobStatus(value: string): JobStatus {
  if (
    value === "Queued" ||
    value === "Running" ||
    value === "Completed" ||
    value === "Failed" ||
    value === "Retrying" ||
    value === "Cancelled"
  ) {
    return value;
  }
  throw new DomainError(
    "Job status must be Queued, Running, Completed, Failed, Retrying, or Cancelled.",
  );
}

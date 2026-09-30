/**
 * Job aggregate. Jobs owns the job record. The module that does the work owns the result.
 * The queue, retries, and workers are US-129. This type does not transition status.
 */

import { type Instant, instant } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import {
  derivedAssetId,
  type DerivedAssetId,
  type JobId,
  jobId,
  mediaAssetId,
  type MediaAssetId,
  projectId,
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

export interface JobSnapshot {
  readonly id: string;
  readonly subject: {
    readonly kind: string;
    readonly projectId?: string;
    readonly mediaAssetId?: string;
    readonly derivedAssetId?: string;
  };
  readonly status: string;
  readonly createdAt: bigint | string;
  readonly updatedAt: bigint | string;
}

export class Job {
  readonly id: JobId;
  readonly subject: JobSubject;
  readonly status: JobStatus;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;

  constructor(
    id: JobId | string,
    subject: JobSnapshot["subject"],
    status: string,
    createdAt: Instant | string | bigint,
    updatedAt?: Instant | string | bigint,
  ) {
    const created = instant(createdAt);
    this.id = jobId(String(id));
    this.subject = Object.freeze(parseSubject(subject));
    this.status = jobStatus(status);
    this.createdAt = created;
    this.updatedAt = updatedAt == null ? created : instant(updatedAt);
    Object.freeze(this);
  }

  static create(id: JobId, subject: JobSubject, createdAt: Instant): Job {
    return new Job(id, subject, "Queued", createdAt, createdAt);
  }

  /** Rebuild a persisted Job in whatever status was stored. Does not run a transition. */
  static restore(snapshot: JobSnapshot): Job {
    return new Job(
      snapshot.id,
      snapshot.subject,
      snapshot.status,
      snapshot.createdAt,
      snapshot.updatedAt,
    );
  }

  toSnapshot(): JobSnapshot {
    return {
      id: this.id,
      subject: { ...this.subject },
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
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

function parseSubject(value: JobSnapshot["subject"]): JobSubject {
  if (value.kind === "project") {
    if (value.projectId == null) {
      throw new DomainError("A project Job subject requires a Project id.");
    }
    return Object.freeze({ kind: "project", projectId: projectId(value.projectId) });
  }
  if (value.kind === "media-asset") {
    if (value.mediaAssetId == null) {
      throw new DomainError("A media-asset Job subject requires a MediaAsset id.");
    }
    return Object.freeze({ kind: "media-asset", mediaAssetId: mediaAssetId(value.mediaAssetId) });
  }
  if (value.kind === "derived-asset") {
    if (value.derivedAssetId == null) {
      throw new DomainError("A derived-asset Job subject requires a DerivedAsset id.");
    }
    return Object.freeze({
      kind: "derived-asset",
      derivedAssetId: derivedAssetId(value.derivedAssetId),
    });
  }
  throw new DomainError("Job subject kind must be project, media-asset, or derived-asset.");
}

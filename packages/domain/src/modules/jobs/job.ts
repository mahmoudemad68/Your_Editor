/**
 * Job aggregate. Jobs owns the job record. The module that does the work owns the result.
 * Status changes go through the transition methods. Illegal moves throw DomainError.
 */

import { type Instant, instant, requireAuditOrder } from "../../kernel/clock.js";
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

/** State names from the job state machine. */
export type JobStatus = "Queued" | "Running" | "Completed" | "Failed" | "Retrying" | "Cancelled";

const LEGAL_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  Queued: ["Running", "Cancelled"],
  Running: ["Completed", "Failed", "Retrying", "Cancelled"],
  Retrying: ["Running", "Failed", "Cancelled"],
  Completed: [],
  Failed: [],
  Cancelled: [],
};

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
  readonly failureReason?: string | null;
  readonly attemptCount?: number;
  readonly queueName?: string | null;
  readonly jobType?: string | null;
  readonly idempotencyKey?: string | null;
  readonly timeoutMs?: number | null;
  readonly maxAttempts?: number | null;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface JobWork {
  readonly queueName: string;
  readonly jobType: string;
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export class Job {
  readonly id: JobId;
  readonly subject: JobSubject;
  readonly status: JobStatus;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly failureReason: string | null;
  readonly attemptCount: number;
  readonly queueName: string | null;
  readonly jobType: string | null;
  readonly idempotencyKey: string | null;
  readonly timeoutMs: number | null;
  readonly maxAttempts: number | null;
  readonly payload: Readonly<Record<string, unknown>>;

  constructor(
    id: JobId | string,
    subject: JobSnapshot["subject"],
    status: string,
    createdAt: Instant | string | bigint,
    updatedAt?: Instant | string | bigint,
    failureReason: string | null = null,
    attemptCount = 0,
    queueName: string | null = null,
    jobType: string | null = null,
    idempotencyKey: string | null = null,
    timeoutMs: number | null = null,
    maxAttempts: number | null = null,
    payload: Readonly<Record<string, unknown>> = {},
  ) {
    const created = instant(createdAt);
    this.id = jobId(String(id));
    this.subject = Object.freeze(parseSubject(subject));
    this.status = jobStatus(status);
    this.createdAt = created;
    this.updatedAt = updatedAt == null ? created : instant(updatedAt);
    this.failureReason = blankToNull(failureReason);
    this.attemptCount = requireCount(attemptCount);
    this.queueName = blankToNull(queueName);
    this.jobType = blankToNull(jobType);
    this.idempotencyKey = blankToNull(idempotencyKey);
    this.timeoutMs = requireOptionalPositive(timeoutMs, "timeoutMs");
    this.maxAttempts = requireOptionalPositive(maxAttempts, "maxAttempts");
    this.payload = parsePayload(payload);
    requireAuditOrder(this.createdAt, this.updatedAt);
    Object.freeze(this);
  }

  static create(id: JobId, subject: JobSubject, createdAt: Instant, work?: JobWork): Job {
    return new Job(
      id,
      subject,
      "Queued",
      createdAt,
      createdAt,
      null,
      0,
      work?.queueName ?? null,
      work?.jobType ?? null,
      work?.idempotencyKey ?? null,
      work?.timeoutMs ?? null,
      work?.maxAttempts ?? null,
      work?.payload ?? {},
    );
  }

  /** Rebuild a persisted Job in whatever status was stored. Does not run a transition. */
  static restore(snapshot: JobSnapshot): Job {
    return new Job(
      snapshot.id,
      snapshot.subject,
      snapshot.status,
      snapshot.createdAt,
      snapshot.updatedAt,
      snapshot.failureReason ?? null,
      snapshot.attemptCount ?? 0,
      snapshot.queueName ?? null,
      snapshot.jobType ?? null,
      snapshot.idempotencyKey ?? null,
      snapshot.timeoutMs ?? null,
      snapshot.maxAttempts ?? null,
      snapshot.payload ?? {},
    );
  }

  start(at: Instant): Job {
    return this.move("Running", at, null, this.attemptCount + 1);
  }

  complete(at: Instant): Job {
    return this.move("Completed", at, null, this.attemptCount);
  }

  fail(at: Instant, reason: string): Job {
    return this.move("Failed", at, requireReason(reason), this.attemptCount);
  }

  retry(at: Instant, reason: string): Job {
    return this.move("Retrying", at, requireReason(reason), this.attemptCount);
  }

  cancel(at: Instant): Job {
    return this.move("Cancelled", at, this.failureReason, this.attemptCount);
  }

  toSnapshot(): JobSnapshot {
    return {
      id: this.id,
      subject: { ...this.subject },
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      failureReason: this.failureReason,
      attemptCount: this.attemptCount,
      queueName: this.queueName,
      jobType: this.jobType,
      idempotencyKey: this.idempotencyKey,
      timeoutMs: this.timeoutMs,
      maxAttempts: this.maxAttempts,
      payload: this.payload,
    };
  }

  private move(
    status: JobStatus,
    at: Instant,
    failureReason: string | null,
    attemptCount: number,
  ): Job {
    const allowed = LEGAL_TRANSITIONS[this.status];
    if (!allowed.includes(status)) {
      throw new DomainError(`Illegal job transition from ${this.status} to ${status}.`);
    }
    return new Job(
      this.id,
      this.subject,
      status,
      this.createdAt,
      at,
      failureReason,
      attemptCount,
      this.queueName,
      this.jobType,
      this.idempotencyKey,
      this.timeoutMs,
      this.maxAttempts,
      this.payload,
    );
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

function blankToNull(value: string | null): string | null {
  if (value == null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new DomainError("A failed or retrying job requires a reason.");
  }
  return trimmed;
}

function requireCount(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new DomainError("Job attemptCount must be a non-negative integer.");
  }
  return value;
}

function parsePayload(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("Job payload must be an object.");
  }
  return Object.freeze({ ...value });
}

function requireOptionalPositive(value: number | null, name: string): number | null {
  if (value == null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new DomainError(`${name} must be a positive integer.`);
  }
  return value;
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

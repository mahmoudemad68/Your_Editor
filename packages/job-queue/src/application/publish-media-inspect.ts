import { mediaAssetId, jobId } from "@editagent/domain";

import { IdempotencyConflictError } from "./job-errors.js";
import { enqueueJob, type RunJobDeps } from "./run-job.js";

import {
  MEDIA_INSPECT_TIMEOUT_MS,
  validationPolicySignature,
  assertInspectionTimeoutBudget,
  type ValidationPolicy,
} from "@editagent/shared";
export const MEDIA_INSPECT_JOB_TYPE = "media.inspect";
export { MEDIA_INSPECT_TIMEOUT_MS } from "@editagent/shared";
export const MEDIA_INSPECT_MAX_ATTEMPTS = 2;
export const MEDIA_INSPECT_BACKOFF_MS = 400;

/** Rejects a queue name the composition root already chose. */
export function mediaInspectQueueName(queueName: string): string {
  if (
    queueName.length === 0 ||
    queueName.includes(":") ||
    queueName !== queueName.trim() ||
    queueName.length > 64
  ) {
    throw new Error("The media inspect queue name must be short and must not contain a colon.");
  }
  return queueName;
}

/**
 * Publishes one inspect job through the US-129 use case.
 * correlationId is stored inside the envelope payload.
 * The idempotency key is the asset id, so a repeat publishes the stored job.
 */
export async function publishMediaInspectJob(
  deps: RunJobDeps,
  input: {
    readonly jobId: string;
    readonly mediaAssetId: string;
    readonly correlationId: string;
    readonly queueName: string;
  },
): Promise<{ jobId: string; duplicate: boolean }> {
  const assetId = mediaAssetId(input.mediaAssetId);
  return enqueueInspection(deps, {
    id: input.jobId,
    queueName: mediaInspectQueueName(input.queueName),
    jobType: MEDIA_INSPECT_JOB_TYPE,
    idempotencyKey: `media.inspect.${assetId}`,
    payload: {
      correlationId: input.correlationId,
      mediaAssetId: assetId,
    },
    subject: { kind: "media-asset", mediaAssetId: assetId },
    timeoutMs: MEDIA_INSPECT_TIMEOUT_MS,
    maxAttempts: MEDIA_INSPECT_MAX_ATTEMPTS,
    backoffBaseMs: MEDIA_INSPECT_BACKOFF_MS,
  });
}

/**
 * Explicit queue-backed retry/revalidation. The caller names a terminal inspection
 * predecessor, not a random request/correlation ID. Equivalent requests (including
 * concurrent callers) share one durable US-129 job; history remains immutable.
 * A further bounded retry requires naming the newly terminal successor explicitly.
 */
export async function requestMediaRevalidation(
  deps: RunJobDeps,
  input: {
    readonly jobId: string;
    readonly mediaAssetId: string;
    readonly previousJobId: string;
    readonly correlationId: string;
    readonly queueName: string;
    readonly policy: ValidationPolicy;
  },
): Promise<{ jobId: string; duplicate: boolean }> {
  const asset = mediaAssetId(input.mediaAssetId);
  assertInspectionTimeoutBudget(input.policy);
  const previous = await deps.jobs.findById(jobId(input.previousJobId));
  if (
    previous === null ||
    previous.jobType !== MEDIA_INSPECT_JOB_TYPE ||
    previous.subject.kind !== "media-asset" ||
    previous.subject.mediaAssetId !== asset ||
    previous.queueName !== mediaInspectQueueName(input.queueName) ||
    !["Completed", "Failed", "Cancelled"].includes(previous.status)
  )
    throw new Error("Revalidation requires a terminal inspection of this asset in this queue.");
  const signature = validationPolicySignature(input.policy);
  return enqueueInspection(deps, {
    id: input.jobId,
    queueName: input.queueName,
    jobType: MEDIA_INSPECT_JOB_TYPE,
    idempotencyKey: `media.inspect.${asset}.${signature}.after.${previous.id}`,
    payload: {
      mediaAssetId: asset,
      correlationId: input.correlationId,
      policySignature: signature,
    },
    subject: { kind: "media-asset", mediaAssetId: asset },
    timeoutMs: MEDIA_INSPECT_TIMEOUT_MS,
    maxAttempts: MEDIA_INSPECT_MAX_ATTEMPTS,
    backoffBaseMs: MEDIA_INSPECT_BACKOFF_MS,
  });
}

// Correlation IDs describe the first delivery, never the semantic identity.
// Reuse the winner's exact envelope on both ordinary and raced duplicate calls.
async function enqueueInspection(deps: RunJobDeps, input: Parameters<typeof enqueueJob>[1]) {
  const existing = await deps.jobs.findByIdempotencyKey(input.idempotencyKey);
  if (existing) {
    if (
      existing.jobType !== input.jobType ||
      existing.queueName !== input.queueName ||
      existing.subject.kind !== "media-asset" ||
      input.subject.kind !== "media-asset" ||
      existing.subject.mediaAssetId !== input.subject.mediaAssetId ||
      existing.payload["policySignature"] !== input.payload["policySignature"]
    )
      throw new IdempotencyConflictError();
    return enqueueJob(deps, {
      ...input,
      payload: existing.payload,
      timeoutMs: existing.timeoutMs ?? input.timeoutMs,
      maxAttempts: existing.maxAttempts ?? input.maxAttempts,
    });
  }
  try {
    return await enqueueJob(deps, input);
  } catch (error) {
    if (!(error instanceof IdempotencyConflictError)) throw error;
    // The US-129 unique-key race has already persisted a winner; reconcile its
    // original correlation rather than changing history or creating extra work.
    if (await deps.jobs.findByIdempotencyKey(input.idempotencyKey))
      return enqueueInspection(deps, input);
    throw error;
  }
}

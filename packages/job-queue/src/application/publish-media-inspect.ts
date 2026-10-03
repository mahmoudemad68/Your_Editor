import { mediaAssetId } from "@editagent/domain";

import { enqueueJob, type RunJobDeps } from "./run-job.js";

export const MEDIA_INSPECT_JOB_TYPE = "media.inspect";
export const MEDIA_INSPECT_TIMEOUT_MS = 30_000;
export const MEDIA_INSPECT_MAX_ATTEMPTS = 2;
export const MEDIA_INSPECT_BACKOFF_MS = 400;

export const MEDIA_INSPECT_QUEUE = "media";

/** Rejects queue names that would break the BullMQ key or the dead-letter name. */
export function mediaInspectQueueName(queueName: string = MEDIA_INSPECT_QUEUE): string {
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
    readonly queueName?: string;
  },
): Promise<{ jobId: string; duplicate: boolean }> {
  const assetId = mediaAssetId(input.mediaAssetId);
  return enqueueJob(deps, {
    id: input.jobId,
    queueName: mediaInspectQueueName(input.queueName ?? MEDIA_INSPECT_QUEUE),
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

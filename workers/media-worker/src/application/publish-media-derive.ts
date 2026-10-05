import { mediaAssetId, projectId } from "@editagent/domain";
import { enqueueJob, mediaInspectQueueName, type RunJobDeps } from "@editagent/job-queue";
import { DERIVATION_VERSION, DERIVE_TIMEOUT_MS } from "./derivative-plan.js";

/** Explicit operator trigger until US-127 can schedule validated sources. */
export async function publishMediaDeriveJob(
  deps: RunJobDeps,
  input: {
    jobId: string;
    mediaAssetId: string;
    projectId: string;
    correlationId: string;
    queueName: string;
  },
) {
  const id = mediaAssetId(input.mediaAssetId);
  const project = projectId(input.projectId);
  return enqueueJob(deps, {
    id: input.jobId,
    queueName: mediaInspectQueueName(input.queueName),
    jobType: "media.derive",
    idempotencyKey: `media.derive.${project}.${id}.${DERIVATION_VERSION}`,
    subject: { kind: "media-asset", mediaAssetId: id },
    payload: {
      mediaAssetId: id,
      projectId: project,
      correlationId: input.correlationId,
      version: DERIVATION_VERSION,
    },
    timeoutMs: DERIVE_TIMEOUT_MS,
    maxAttempts: 3,
    backoffBaseMs: 1000,
  });
}

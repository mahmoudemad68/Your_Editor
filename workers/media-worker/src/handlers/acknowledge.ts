/**
 * Completes a media.inspect reservation.
 * The payload must carry the request correlation id. FFprobe stays in US-126.
 */

import { type JobEnvelope } from "@editagent/domain";

import { PermanentJobError } from "../application/job-errors.js";

export async function acknowledge(envelope: JobEnvelope): Promise<void> {
  const correlationId = envelope.payload["correlationId"];
  const assetId = envelope.payload["mediaAssetId"];
  if (typeof correlationId !== "string" || correlationId.length === 0) {
    throw new PermanentJobError("media.inspect payload is missing correlationId.");
  }
  if (typeof assetId !== "string" || assetId.length === 0) {
    throw new PermanentJobError("media.inspect payload is missing mediaAssetId.");
  }
}

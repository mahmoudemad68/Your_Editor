import { randomBytes } from "node:crypto";
import {
  createUuidV7,
  instant,
  mediaAssetId,
  projectId,
  type JobEnvelope,
} from "@editagent/domain";
import { BullMqJobQueue } from "@editagent/job-queue";
import { Pool } from "pg";
import { deriveMediaAsset } from "../application/derive-media.js";
import { DERIVATION_VERSION } from "../application/derivative-plan.js";
import { PermanentJobError } from "../application/job-errors.js";
import { loadMediaWorkerConfig } from "../infrastructure/config.js";
import { FFmpegDerivativeProcessor } from "../infrastructure/ffmpeg-derivative-processor.js";
import { FileObjectStager } from "../infrastructure/object-stager.js";
import { PostgresDerivedAssets } from "../infrastructure/postgres-derived-assets.js";
import { S3DerivedObjects } from "../infrastructure/s3-derived-objects.js";
import { createMediaS3Client, S3ObjectByteSource } from "../infrastructure/s3-object-stream.js";
import { acknowledge } from "./acknowledge.js";

export function validateDerivationEnvelope(envelope: JobEnvelope): {
  mediaAssetId: ReturnType<typeof mediaAssetId>;
  projectId: string;
} {
  const p = envelope.payload;
  if (
    envelope.jobType !== "media.derive" ||
    envelope.subject.kind !== "media-asset" ||
    p["version"] !== DERIVATION_VERSION ||
    typeof p["mediaAssetId"] !== "string" ||
    envelope.subject.id !== p["mediaAssetId"] ||
    typeof p["projectId"] !== "string" ||
    typeof p["correlationId"] !== "string" ||
    p["correlationId"].length === 0 ||
    Object.keys(p).sort().join(",") !== "correlationId,mediaAssetId,projectId,version"
  )
    throw new PermanentJobError("Invalid versioned derivation intent.");
  try {
    return { mediaAssetId: mediaAssetId(p["mediaAssetId"]), projectId: projectId(p["projectId"]) };
  } catch {
    throw new PermanentJobError("Invalid derivation subject.");
  }
}
export async function handleMediaJob(envelope: JobEnvelope, signal: AbortSignal): Promise<void> {
  if (envelope.jobType === "media.inspect") return acknowledge(envelope);
  const input = validateDerivationEnvelope(envelope);
  const config = loadMediaWorkerConfig();
  if (!config.allowUnvalidatedDerivation)
    throw new PermanentJobError(
      "US-127 validation is unavailable; explicit operator opt-in is required.",
    );
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
  const s3 = createMediaS3Client(config.objectStorage);
  const progress = new BullMqJobQueue(config.redisUrl);
  try {
    await deriveMediaAsset(input.mediaAssetId, input.projectId, signal, {
      repository: new PostgresDerivedAssets(pool),
      objects: new S3DerivedObjects(s3, config.objectStorage.bucket),
      staging: new FileObjectStager({
        source: new S3ObjectByteSource(s3, config.objectStorage.bucket),
        ...(config.probeTmpDir === null ? {} : { rootDir: config.probeTmpDir }),
      }),
      processor: new FFmpegDerivativeProcessor(config.ffmpegPath, config.ffprobePath),
      gate: {
        assertAllowed: async () => {
          signal.throwIfAborted();
        },
      },
      onStage: async (stage) => {
        try {
          await progress.publishProgress(envelope.jobId, { message: stage });
        } catch {
          process.stderr.write("media.derive stage publication unavailable\n");
        }
      },
      now: () => instant(BigInt(Date.now())),
      newId: () => createUuidV7(Date.now(), randomBytes(10)),
    });
  } finally {
    s3.destroy();
    try {
      await progress.close();
    } finally {
      await pool.end();
    }
  }
}

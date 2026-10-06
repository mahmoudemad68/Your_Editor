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
import { validateMediaAsset, assertValidatedMedia } from "../application/validate-media.js";
import { validationPolicySignature } from "../application/validation-policy.js";
import {
  SandboxedMediaValidator,
  assertValidationSandbox,
} from "../infrastructure/media-validator.js";

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
  const inspecting = envelope.jobType === "media.inspect";
  const input = inspecting
    ? validateInspectionEnvelope(envelope)
    : validateDerivationEnvelope(envelope);
  const config = loadMediaWorkerConfig();
  assertValidationSandbox();
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
  const s3 = createMediaS3Client(config.objectStorage);
  const progress = new BullMqJobQueue(config.redisUrl);
  try {
    if (inspecting) {
      const repository = new PostgresDerivedAssets(pool);
      const validated = await repository.withSourceLock(
        input.mediaAssetId,
        signal,
        async (store) => {
          // The lock-bound store shares this one connection; never acquire a
          // second pool connection while holding the source lock (pool max=1).
          if (!(store instanceof PostgresDerivedAssets))
            throw new Error("Validation store unavailable.");
          return validateMediaAsset(input.mediaAssetId, signal, {
            media: store.inspectionRepository(),
            staging: new FileObjectStager({
              source: new S3ObjectByteSource(s3, config.objectStorage.bucket),
              ...(config.probeTmpDir === null ? {} : { rootDir: config.probeTmpDir }),
            }),
            validator: new SandboxedMediaValidator(
              config.validationPolicy,
              config.ffmpegPath,
              config.ffprobePath,
            ),
            now: () => instant(BigInt(Date.now())),
          });
        },
      );
      if (validated.validation.status !== "validated")
        throw new PermanentJobError(
          `Media rejected: ${validated.validation.rejectionCode ?? "invalid_metadata"}.`,
        );
      return;
    }
    const derivation = validateDerivationEnvelope(envelope);
    await deriveMediaAsset(derivation.mediaAssetId, derivation.projectId, signal, {
      repository: new PostgresDerivedAssets(pool),
      objects: new S3DerivedObjects(s3, config.objectStorage.bucket),
      staging: new FileObjectStager({
        source: new S3ObjectByteSource(s3, config.objectStorage.bucket),
        ...(config.probeTmpDir === null ? {} : { rootDir: config.probeTmpDir }),
      }),
      processor: new FFmpegDerivativeProcessor(config.ffmpegPath, config.ffprobePath),
      gate: {
        assertAllowed: async (source, abort) =>
          assertValidatedMedia(source, validationPolicySignature(config.validationPolicy), abort),
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

export function validateInspectionEnvelope(envelope: JobEnvelope): {
  mediaAssetId: ReturnType<typeof mediaAssetId>;
} {
  const p = envelope.payload;
  if (
    envelope.jobType !== "media.inspect" ||
    envelope.subject.kind !== "media-asset" ||
    p["mediaAssetId"] !== envelope.subject.id ||
    typeof p["mediaAssetId"] !== "string" ||
    typeof p["correlationId"] !== "string" ||
    p["correlationId"].length === 0 ||
    Object.keys(p).sort().join(",") !== "correlationId,mediaAssetId"
  )
    throw new PermanentJobError("Invalid inspection subject.");
  try {
    return { mediaAssetId: mediaAssetId(p["mediaAssetId"]) };
  } catch {
    throw new PermanentJobError("Invalid inspection subject.");
  }
}

/**
 * Manual inspection entry point.
 * Automatic post-upload inspection waits for US-129. That job handler should
 * call inspectMediaAsset with these same adapters. This process is not a queue.
 */

import { instant, type MediaAssetId, mediaAssetId } from "@editagent/domain";
import {
  SandboxedMediaValidator,
  assertValidationSandbox,
} from "./infrastructure/media-validator.js";
import { Pool } from "pg";
import { validateMediaAsset } from "./application/validate-media.js";
import { loadMediaWorkerConfig } from "./infrastructure/config.js";
import { FileObjectStager } from "./infrastructure/object-stager.js";
import { PostgresDerivedAssets } from "./infrastructure/postgres-derived-assets.js";
import { createMediaS3Client, S3ObjectByteSource } from "./infrastructure/s3-object-stream.js";

export async function inspectStoredMedia(rawId: string): Promise<number> {
  const config = loadMediaWorkerConfig();
  assertValidationSandbox();
  const mediaAssetId = parseMediaAssetId(rawId);
  const pool = new Pool({ connectionString: config.databaseUrl });
  const client = createMediaS3Client(config.objectStorage);
  try {
    const signal = new AbortController().signal;
    const asset = await new PostgresDerivedAssets(pool).withSourceLock(
      mediaAssetId,
      signal,
      async (store) => {
        if (!(store instanceof PostgresDerivedAssets))
          throw new Error("Validation store unavailable.");
        return validateMediaAsset(mediaAssetId, signal, {
          media: store.inspectionRepository(),
          staging: new FileObjectStager({
            source: new S3ObjectByteSource(client, config.objectStorage.bucket),
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
    const error = asset.inspectionError ?? "-";
    process.stdout.write(`inspection ${asset.id} ${asset.inspectionStatus} ${error}\n`);
    return asset.validation.status === "validated" ? 0 : 1;
  } finally {
    client.destroy();
    await pool.end();
  }
}

function parseMediaAssetId(value: string): MediaAssetId {
  return mediaAssetId(value);
}

if (require.main === module) {
  const rawId = process.argv[2];
  if (rawId === undefined || process.argv.length !== 3) {
    process.stderr.write("usage: node dist/inspect.js <mediaAssetId>\n");
    process.exitCode = 1;
  } else {
    inspectStoredMedia(rawId).then(
      (code) => {
        process.exitCode = code;
      },
      () => {
        process.stderr.write("Media inspection failed.\n");
        process.exitCode = 1;
      },
    );
  }
}

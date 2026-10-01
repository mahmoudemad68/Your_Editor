/**
 * Manual inspection entry point.
 * Automatic post-upload inspection waits for US-129. That job handler should
 * call inspectMediaAsset with these same adapters. This process is not a queue.
 */

import { instant, type MediaAssetId, mediaAssetId } from "@editagent/domain";
import { FFprobeMediaProbe } from "@editagent/media-core";
import { Pool } from "pg";
import { inspectMediaAsset } from "./application/inspect-media.js";
import { loadMediaWorkerConfig } from "./infrastructure/config.js";
import { FileObjectStager } from "./infrastructure/object-stager.js";
import { PostgresMediaInspectionRepository } from "./infrastructure/postgres-media-inspection-repository.js";
import { createMediaS3Client, S3ObjectByteSource } from "./infrastructure/s3-object-stream.js";

export async function inspectStoredMedia(rawId: string): Promise<number> {
  const config = loadMediaWorkerConfig();
  const mediaAssetId = parseMediaAssetId(rawId);
  const pool = new Pool({ connectionString: config.databaseUrl });
  const client = createMediaS3Client(config.objectStorage);
  try {
    const asset = await inspectMediaAsset(mediaAssetId, {
      media: new PostgresMediaInspectionRepository(pool),
      staging: new FileObjectStager({
        source: new S3ObjectByteSource(client, config.objectStorage.bucket),
        ...(config.probeTmpDir === null ? {} : { rootDir: config.probeTmpDir }),
      }),
      probe: new FFprobeMediaProbe({
        executable: config.ffprobePath,
        timeoutMs: config.ffprobeTimeoutMs,
      }),
      clock: { now: () => instant(BigInt(Date.now())) },
    });
    const error = asset.inspectionError ?? "-";
    process.stdout.write(`inspection ${asset.id} ${asset.inspectionStatus} ${error}\n`);
    return asset.inspectionStatus === "completed" ? 0 : 1;
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

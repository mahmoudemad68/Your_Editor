/** Operations entry point; schedule hourly. No new background service/timer. */
import { Pool } from "pg";
import { MultipartUploads } from "./application/multipart-uploads.js";
import { UPLOAD_SESSION_TTL_MS } from "@editagent/domain";
import { loadApiConfig } from "./infrastructure/config.js";
import { PostgresUploadSessionRepository } from "./infrastructure/postgres-upload-sessions.js";
import { PostgresProjectRepository } from "./infrastructure/postgres-project-repository.js";
import { PostgresMediaAssetRepository } from "./infrastructure/postgres-media-repository.js";
import { NodeMediaAssetIdGenerator } from "./infrastructure/node-media-asset-id-generator.js";
import { S3ObjectStorage } from "./infrastructure/s3-object-storage.js";
import { SystemClock } from "./infrastructure/system-clock.js";
async function cleanup(): Promise<void> {
  const config = loadApiConfig(),
    pool = new Pool({ connectionString: config.databaseUrl }),
    objects = new S3ObjectStorage(config.objectStorage),
    clock = new SystemClock();
  try {
    const uploads = new MultipartUploads(
      new PostgresProjectRepository(pool),
      new PostgresUploadSessionRepository(pool),
      objects,
      new PostgresMediaAssetRepository(pool),
      new NodeMediaAssetIdGenerator(),
      clock,
      config.objectStorage.presignTtlSeconds,
    );
    let expired = 0,
      processed = 0;
    do {
      processed = await uploads.cleanupExpired(100);
      expired += processed;
    } while (processed === 100);
    const orphaned = await objects.abortStaleMultipart(
      new Date(Number(clock.now() - UPLOAD_SESSION_TTL_MS)),
    );
    process.stdout.write(
      `Expired sessions: ${expired}; stale provider uploads aborted: ${orphaned}\n`,
    );
  } finally {
    objects.close();
    await pool.end();
  }
}
if (require.main === module)
  void cleanup().catch(() => {
    process.stderr.write(
      "Upload cleanup failed; retry with the configured database/storage connections.\n",
    );
    process.exitCode = 1;
  });

import "reflect-metadata";
import { createServiceLogger, startNoopTracing } from "@editagent/shared";
import { Pool } from "pg";
import { createApiApplication } from "./create-api-application.js";
import { ConfigurationError, loadApiConfig } from "./infrastructure/config.js";
import { applyMigrations } from "./infrastructure/migrate.js";
import { NodeMediaAssetIdGenerator } from "./infrastructure/node-media-asset-id-generator.js";
import { NodeProjectIdGenerator } from "./infrastructure/node-project-id-generator.js";
import { PostgresMediaAssetRepository } from "./infrastructure/postgres-media-repository.js";
import { PostgresProjectRepository } from "./infrastructure/postgres-project-repository.js";
import { S3ObjectStorage } from "./infrastructure/s3-object-storage.js";
import { SystemClock } from "./infrastructure/system-clock.js";

export async function bootstrap(): Promise<void> {
  startNoopTracing("api");
  const logger = createServiceLogger("api");
  const config = loadApiConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  await applyMigrations(pool);
  const app = await createApiApplication({
    projects: new PostgresProjectRepository(pool),
    clock: new SystemClock(),
    ids: new NodeProjectIdGenerator(),
    media: new PostgresMediaAssetRepository(pool),
    objects: new S3ObjectStorage(config.objectStorage),
    mediaIds: new NodeMediaAssetIdGenerator(),
    presignTtlSeconds: config.objectStorage.presignTtlSeconds,
    logger,
  });
  await app.listen(config.port, config.host);
}

if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    if (error instanceof ConfigurationError) {
      process.stderr.write(`${error.message}\n`);
    } else if (error instanceof Error) {
      process.stderr.write(`${error.stack ?? error.message}\n`);
    } else {
      process.stderr.write(`${String(error)}\n`);
    }
    process.exitCode = 1;
  });
}

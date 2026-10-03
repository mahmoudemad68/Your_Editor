import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { createUuidV7 } from "@editagent/domain";
import {
  BullMqJobQueue,
  observePostgresPool,
  PostgresJobRepository,
  postgresAndRedisReady,
  publishMediaInspectJob,
} from "@editagent/job-queue";
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
  observePostgresPool(pool, (error) => {
    logger.error({ err: error.message }, "postgres.pool.disconnected");
  });
  await applyMigrations(pool);
  const clock = new SystemClock();
  const jobs = new PostgresJobRepository(pool);
  const queue = new BullMqJobQueue(config.redisUrl);
  const app = await createApiApplication({
    projects: new PostgresProjectRepository(pool),
    clock,
    ids: new NodeProjectIdGenerator(),
    media: new PostgresMediaAssetRepository(pool),
    objects: new S3ObjectStorage(config.objectStorage),
    mediaIds: new NodeMediaAssetIdGenerator(),
    presignTtlSeconds: config.objectStorage.presignTtlSeconds,
    logger,
    readiness: {
      check: () => postgresAndRedisReady(pool, config.redisUrl),
    },
    inspectJobs: {
      async publish(mediaAssetId: string, correlationId: string): Promise<void> {
        await publishMediaInspectJob(
          {
            jobs,
            queue,
            supervisor: {
              async run(): Promise<void> {
                throw new Error("The API does not run jobs.");
              },
            },
            now: () => clock.now(),
            newAttemptId: () => createUuidV7(Date.now(), randomBytes(10)),
          },
          {
            jobId: createUuidV7(Date.now(), randomBytes(10)),
            mediaAssetId,
            correlationId,
            queueName: config.mediaInspectQueue,
          },
        );
      },
    },
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

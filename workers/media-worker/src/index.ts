import { Pool } from "pg";
import { BullMqJobQueue, observePostgresPool, postgresAndRedisReady } from "@editagent/job-queue";
import {
  createServiceLogger,
  keepProcessAlive,
  startHealthServer,
  startNoopTracing,
} from "@editagent/shared";
import { describeWorker } from "./application/describe.js";
import { consumeMediaJobs } from "./consume-media-jobs.js";
import { loadMediaWorkerConfig } from "./infrastructure/config.js";
import { mediaAdapterPackage } from "./infrastructure/marker.js";

export function main(): void {
  const config = loadMediaWorkerConfig();
  startNoopTracing("media-worker");
  const logger = createServiceLogger("media-worker");
  const pool = new Pool({ connectionString: config.databaseUrl });
  observePostgresPool(pool, (error) => {
    logger.error({ err: error.message }, "postgres.pool.disconnected");
  });
  const queue = new BullMqJobQueue(config.redisUrl);
  startHealthServer(config.healthPort, {
    ready: () => postgresAndRedisReady(pool, config.redisUrl),
  });
  process.stdout.write(`${describeWorker()} (${mediaAdapterPackage})\n`);
  void consumeMediaJobs(pool, queue, logger, config.mediaInspectQueue).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`media-worker stopped: ${message}\n`);
  });
  keepProcessAlive();
}

if (require.main === module) {
  try {
    main();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

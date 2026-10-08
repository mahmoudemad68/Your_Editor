import { RedisJobEventPublisher } from "@editagent/job-queue";
import { assertValidationSandbox } from "./infrastructure/media-validator.js";
import { Pool } from "pg";
import { BullMqJobQueue, observePostgresPool, postgresAndRedisReady } from "@editagent/job-queue";
import { createServiceLogger, startHealthServer, startNoopTracing } from "@editagent/shared";
import { consumeMediaJobs } from "./consume-media-jobs.js";
import { loadMediaWorkerConfig } from "./infrastructure/config.js";
import { mediaAdapterPackage } from "./infrastructure/marker.js";

export function main(): void {
  const config = loadMediaWorkerConfig();
  assertValidationSandbox();
  startNoopTracing("media-worker");
  const logger = createServiceLogger("media-worker");
  const pool = new Pool({ connectionString: config.databaseUrl });
  observePostgresPool(pool, () => {
    logger.error({ errorCode: "postgres_connection_lost" }, "postgres.pool.disconnected");
  });
  const queue = new BullMqJobQueue(config.redisUrl, {
    events: new RedisJobEventPublisher(pool, config.redisUrl),
  });
  const health = startHealthServer(config.healthPort, {
    ready: () => postgresAndRedisReady(pool, config.redisUrl),
  });
  logger.info({ component: mediaAdapterPackage }, "service.started");
  const shutdown = new AbortController();
  const consuming = consumeMediaJobs(
    pool,
    queue,
    logger,
    config.mediaInspectQueue,
    shutdown.signal,
  ).catch(() => {
    logger.error({ errorCode: "consumer_stopped" }, "service.consumer.stopped");
  });
  const stop = async () => {
    shutdown.abort();
    health.close();
    await queue.close(true);
    await consuming;
    await pool.end();
  };
  process.once("SIGTERM", () => {
    void stop();
  });
  process.once("SIGINT", () => {
    void stop();
  });
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

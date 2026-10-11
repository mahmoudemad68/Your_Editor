import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { createUuidV7, instant } from "@editagent/domain";
import {
  BullMqJobQueue,
  PostgresJobRepository,
  RedisJobEventPublisher,
  runNextJob,
  observePostgresPool,
  postgresAndRedisReady,
} from "@editagent/job-queue";
import { createServiceLogger, startHealthServer, startNoopTracing } from "@editagent/shared";
import { loadRenderWorkerConfig, ConfigurationError } from "./infrastructure/config.js";
import { createStorage, RenderObjects } from "./infrastructure/storage.js";
import { executorReady } from "./infrastructure/remote-render.js";
import { RemotionRenderStrategy } from "./infrastructure/strategy.js";
import { RenderJobSupervisor } from "./infrastructure/render-supervisor.js";
import { PostgresRenderAssetResolver } from "./infrastructure/asset-resolver.js";
export async function main() {
  const config = loadRenderWorkerConfig();
  startNoopTracing("render-worker");
  const logger = createServiceLogger("render-worker");
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 2,
    connectionTimeoutMillis: 1000,
    query_timeout: 5000,
    statement_timeout: 5000,
  });
  observePostgresPool(pool, () =>
    logger.error({ errorCode: "postgres_connection_lost" }, "postgres.pool.disconnected"),
  );
  const queue = new BullMqJobQueue(config.redisUrl, {
    events: new RedisJobEventPublisher(pool, config.redisUrl),
  });
  const s3 = createStorage(config),
    shutdown = new AbortController();
  const health = startHealthServer(3200, {
    ready: async () =>
      (await Promise.all([executorReady(), postgresAndRedisReady(pool, config.redisUrl)])).every(
        Boolean,
      ),
  });
  const strategy = new RemotionRenderStrategy(
    new RenderObjects(s3, config.objectStorage.bucket),
    config.renderTimeoutMs,
    new PostgresRenderAssetResolver(pool),
  );
  const supervisor = new RenderJobSupervisor(
    strategy,
    (id, percentage, attempt) => queue.publishProgress(id, { stage: "mix", percentage, attempt }),
    shutdown.signal,
  );
  const deps = {
    jobs: new PostgresJobRepository(pool),
    queue,
    supervisor,
    now: () => instant(BigInt(Date.now())),
    newAttemptId: () => createUuidV7(Date.now(), randomBytes(10)),
  };
  const loop = (async () => {
    while (!shutdown.signal.aborted) {
      try {
        if (!(await executorReady())) {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          continue;
        }
        const result = await runNextJob(deps, config.renderQueue, {
          modulePath: "registered-renderer",
          exportName: "render",
        });
        if (result === "idle") await new Promise<void>((resolve) => setTimeout(resolve, 100));
      } catch {
        logger.error({ errorCode: "render_consumer_failed" }, "render.consumer.failed");
        if (!shutdown.signal.aborted)
          await new Promise<void>((resolve) => setTimeout(resolve, 500));
      }
    }
  })();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    shutdown.abort();
    health.close();
    await loop;
    await queue.close(true);
    s3.destroy();
    await pool.end();
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  logger.info({ queue: config.renderQueue }, "service.started");
}
if (require.main === module)
  void main().catch((e: unknown) => {
    console.error(e instanceof ConfigurationError ? e.message : "Render worker startup failed.");
    process.exitCode = 1;
  });

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
import { createRenderReadiness, storageReady } from "./infrastructure/readiness.js";
import { RemotionRenderStrategy, FFmpegRenderStrategy } from "./infrastructure/strategy.js";
import { SelectingRenderStrategy } from "./application/strategy-selection.js";
import { RenderJobSupervisor } from "./infrastructure/render-supervisor.js";
import { PostgresRenderAssetResolver } from "./infrastructure/asset-resolver.js";
import { createEditingRuntime } from "./infrastructure/editing-runtime.js";
import { toolQueueName } from "@editagent/tool-sdk";
import { PostgresRenderValidation } from "./infrastructure/render-validation.js";
export async function main() {
  const config = loadRenderWorkerConfig();
  startNoopTracing("render-worker");
  const logger = createServiceLogger("render-worker");
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 6,
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
  const ready = createRenderReadiness(
    [
      executorReady,
      () => postgresAndRedisReady(pool, config.redisUrl),
      () => storageReady(s3, config.objectStorage.bucket),
    ],
    shutdown.signal,
  );
  const health = startHealthServer(3200, { ready });
  const objects = new RenderObjects(s3, config.objectStorage.bucket),
    assets = new PostgresRenderAssetResolver(pool);
  const strategy = new SelectingRenderStrategy(
    new FFmpegRenderStrategy(objects, config.renderTimeoutMs, assets),
    new RemotionRenderStrategy(objects, config.renderTimeoutMs, assets),
  );
  const editing = createEditingRuntime(pool, queue, objects, {
    costMicros: config.editingCostMicros,
    projectBudgetMicros: config.editingProjectBudgetMicros,
  });
  const supervisor = new RenderJobSupervisor(
    strategy,
    (id, percentage, attempt) => queue.publishProgress(id, { stage: "mix", percentage, attempt }),
    shutdown.signal,
    (envelope, input, artifact) =>
      new PostgresRenderValidation(pool).record(envelope, input, artifact),
  );
  const deps = {
    jobs: new PostgresJobRepository(pool),
    queue,
    supervisor,
    now: () => instant(BigInt(Date.now())),
    newAttemptId: () => createUuidV7(Date.now(), randomBytes(10)),
  };
  const loop = (async () => {
    let toolsTurn = false;
    let recoveryAt = 0;
    while (!shutdown.signal.aborted) {
      try {
        if (!(await executorReady())) {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          continue;
        }
        if (Date.now() >= recoveryAt) {
          await editing.executor.recover();
          await editing.reclaim(shutdown.signal);
          recoveryAt = Date.now() + 1000;
        }
        toolsTurn = !toolsTurn;
        const result = await runNextJob(
          toolsTurn ? editing.deps : deps,
          toolsTurn ? toolQueueName("render") : config.renderQueue,
          {
            modulePath: "registered-renderer",
            exportName: "render",
          },
        );
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

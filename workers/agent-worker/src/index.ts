import { PostgresAgentRuns, consumeAgentRuns } from "@editagent/agent-core";
import { BullMqJobQueue, observePostgresPool, postgresAndRedisReady } from "@editagent/job-queue";
import {
  createServiceLogger,
  startHealthServer,
  startNoopTracing,
  WORKER_HEALTH_PORT,
} from "@editagent/shared";
import { Pool } from "pg";
import { loadAgentWorkerConfig, agentStartupMessage } from "./infrastructure/config.js";

export async function main(): Promise<void> {
  const config = loadAgentWorkerConfig();
  startNoopTracing("agent-worker");
  const logger = createServiceLogger("agent-worker");
  const pool = new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 1000,
    query_timeout: 2000,
  });
  observePostgresPool(pool, () =>
    logger.error({ errorCode: "postgres_connection_lost" }, "postgres.pool.disconnected"),
  );
  const queue = new BullMqJobQueue(config.redisUrl),
    stop = new AbortController();
  const health = startHealthServer(WORKER_HEALTH_PORT, {
    ready: async () => {
      if (!(await postgresAndRedisReady(pool, config.redisUrl))) return false;
      try {
        await pool.query("SELECT id FROM agent_runs LIMIT 0");
        return true;
      } catch {
        return false;
      }
    },
  });
  const consuming = consumeAgentRuns(new PostgresAgentRuns(pool), queue, stop.signal, () =>
    logger.error({ errorCode: "agent_consumer_failed" }, "agent.consumer.failed"),
  );
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    stop.abort();
    health.close();
    await queue.close(true);
    await consuming;
    await pool.end();
  };
  process.once("SIGTERM", () => {
    void close();
  });
  process.once("SIGINT", () => {
    void close();
  });
  logger.info({ driver: "infrastructure-v1", planner: "not_configured" }, "service.started");
}
if (require.main === module)
  void main().catch((error: unknown) => {
    process.stderr.write(`${agentStartupMessage(error)}\n`);
    process.exitCode = 1;
  });

import { Redis } from "ioredis";
import { type Pool } from "pg";

/**
 * Records idle-client disconnects. node-pg emits `error` on the pool when a
 * connection dies outside a query. Without a listener that event crashes the
 * process. Query failures still reject the query that was running.
 */
export function observePostgresPool(pool: Pool, onError: (error: Error) => void): void {
  pool.on("error", (error: Error) => {
    onError(error);
  });
}

/** Dependency check for /ready. A failed probe is not process liveness. */
export async function postgresAndRedisReady(pool: Pool, redisUrl: string): Promise<boolean> {
  let redis: Redis | undefined;
  try {
    await pool.query("SELECT 1");
    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 1_000,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    await redis.connect();
    return (await redis.ping()) === "PONG";
  } catch {
    return false;
  } finally {
    redis?.disconnect();
  }
}

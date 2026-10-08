import { Redis } from "ioredis";
import { type Pool, type PoolClient } from "pg";

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

/**
 * Each Postgres and Redis command must finish within this long.
 * A paused or silent dependency makes /ready return 503 inside this deadline.
 * /health does not call this function.
 */
export const READINESS_DEADLINE_MS = 1_000;

/** Dependency check for /ready. A failed probe is not process liveness. */
export async function postgresAndRedisReady(pool: Pool, redisUrl: string): Promise<boolean> {
  const postgresOk = await postgresProbe(pool);
  if (!postgresOk) {
    return false;
  }
  return redisProbe(redisUrl);
}

async function postgresProbe(pool: Pool): Promise<boolean> {
  const pending = pool.connect();
  let client: PoolClient | undefined;
  let released = false;
  // Checked-out clients do not have the pool idle-error listener. Keep this
  // handler only for the probe; returning it to the pool must not retain it.
  const onClientError = (): void => undefined;
  const release = (destroy: boolean): void => {
    if (released) {
      return;
    }
    released = true;
    if (client !== undefined) {
      client.removeListener("error", onClientError);
      client.release(destroy);
      return;
    }
    void pending.then(
      (late) => {
        late.release(true);
      },
      () => undefined,
    );
  };
  try {
    client = await withDeadline(pending, READINESS_DEADLINE_MS);
    client.on("error", onClientError);
    await withDeadline(client.query("SELECT 1"), READINESS_DEADLINE_MS);
    release(false);
    return true;
  } catch {
    release(true);
    return false;
  }
}

async function redisProbe(redisUrl: string): Promise<boolean> {
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    connectTimeout: READINESS_DEADLINE_MS,
    commandTimeout: READINESS_DEADLINE_MS,
    enableOfflineQueue: false,
    lazyConnect: true,
    retryStrategy: () => null,
  });
  redis.on("error", () => undefined);
  try {
    await withDeadline(redis.connect(), READINESS_DEADLINE_MS);
    const pong = await withDeadline(redis.ping(), READINESS_DEADLINE_MS);
    return pong === "PONG";
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("readiness deadline exceeded"));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

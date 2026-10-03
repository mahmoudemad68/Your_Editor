import { randomBytes } from "node:crypto";

/** Gives each integration file its own Redis database so BullMQ keys do not collide. */
export function isolatedRedisUrl(database: number, base: string | undefined): string {
  const url = new URL(base ?? "redis://127.0.0.1:6379/0");
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * A UUIDv7's first hex digits are the timestamp and stay the same for about a
 * minute. Queue names need the random tail so one run cannot reserve another
 * run's waiting job.
 */
export function uniqueQueueSuffix(): string {
  return randomBytes(6).toString("hex");
}

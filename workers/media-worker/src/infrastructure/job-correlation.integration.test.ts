/**
 * The media-worker consumer logs correlationId from the reserved payload
 * on start, retry, cancel, and failure. Postgres and Redis are real.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { createUuidV7, jobId, mediaAssetId } from "@editagent/domain";
import { createServiceLogger } from "@editagent/shared";
import { Pool } from "pg";

import { logJobLifecycle } from "../consume-media-jobs.js";
import { cancelJob, enqueueJob, runNextJob, type RunJobDeps } from "../application/run-job.js";
import { type IsolatedHandler } from "../application/job-supervisor.js";
import { BullMqJobQueue } from "./bullmq-job-queue.js";
import { ChildProcessJobSupervisor } from "./child-job-supervisor.js";
import { PostgresJobRepository } from "./postgres-job-repository.js";
import { isolatedRedisUrl, uniqueQueueSuffix } from "./test-redis.js";

const TEST_DATABASE = "editagent_us115_logs";
const handlerModule = path.join(__dirname, "../handlers/sample-handlers.js");
const redisUrl = isolatedRedisUrl(7, process.env["REDIS_URL"]);
const repoRoot = path.resolve(__dirname, "../../../..");

function spec(exportName: string): IsolatedHandler {
  return { modulePath: handlerModule, exportName };
}

function adminUrl(): string {
  return (
    process.env["DATABASE_URL"] ??
    "postgresql://editagent:editagent-dev-password@127.0.0.1:5432/editagent"
  );
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function newId(): string {
  return createUuidV7(Date.now(), randomBytes(10));
}

function clock() {
  let current = 1_700_000_000_000n;
  return () => {
    current += 1n;
    return current;
  };
}

async function applyJobMigration(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const file = "0005_jobs.sql";
  const existing = await pool.query("SELECT id FROM schema_migrations WHERE id = $1", [file]);
  if ((existing.rowCount ?? 0) > 0) {
    return;
  }
  const sql = await readFile(path.join(repoRoot, "apps/api/migrations", file), "utf8");
  await pool.query(sql);
  await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
}

function jsonLines(chunks: readonly string[]): Array<Record<string, unknown>> {
  return chunks
    .join("")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test(
  "reserved jobs log correlation id on retry, cancel, and failure",
  { timeout: 60_000 },
  async () => {
    const admin = new Pool({ connectionString: adminUrl() });
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
    await admin.end();
    const pool = new Pool({ connectionString: withDatabase(adminUrl(), TEST_DATABASE) });
    const queue = new BullMqJobQueue(redisUrl);
    const jobs = new PostgresJobRepository(pool);
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString("utf8"));
        callback();
      },
    });
    const logger = createServiceLogger("media-worker", stream);
    const deps: RunJobDeps = {
      jobs,
      queue,
      supervisor: new ChildProcessJobSupervisor(),
      now: clock(),
      newAttemptId: newId,
      onLifecycle: (event) => {
        logJobLifecycle(logger, event);
      },
    };
    const queueName = `logs${uniqueQueueSuffix()}`;
    const correlationId = "corr-worker-1";
    try {
      await applyJobMigration(pool);
      const media = newId();
      const retryId = newId();
      await enqueueJob(deps, {
        id: retryId,
        queueName,
        jobType: "media.inspect",
        idempotencyKey: `retry-${retryId}`,
        payload: { correlationId, mediaAssetId: media, markerPath: "" },
        subject: { kind: "media-asset", mediaAssetId: mediaAssetId(media) },
        timeoutMs: 5_000,
        maxAttempts: 2,
        backoffBaseMs: 20,
      });
      await runNextJob(deps, queueName, spec("failTransient"));
      await untilStatus(deps, queueName, spec("failTransient"), retryId, "Completed");

      const cancelId = newId();
      await enqueueJob(deps, {
        id: cancelId,
        queueName,
        jobType: "media.inspect",
        idempotencyKey: `cancel-${cancelId}`,
        payload: { correlationId, mediaAssetId: media },
        subject: { kind: "media-asset", mediaAssetId: mediaAssetId(media) },
        timeoutMs: 15_000,
        maxAttempts: 1,
        backoffBaseMs: 20,
      });
      const running = runNextJob(deps, queueName, spec("cooperativeCancel"));
      const startedAt = Date.now();
      while (Date.now() - startedAt < 5_000) {
        const started = jsonLines(lines).some(
          (line) => line["message"] === "job.started" && line["jobId"] === cancelId,
        );
        if (started) {
          break;
        }
        await delay(50);
      }
      await cancelJob(deps, cancelId);
      await running;

      const failId = newId();
      await enqueueJob(deps, {
        id: failId,
        queueName,
        jobType: "media.inspect",
        idempotencyKey: `fail-${failId}`,
        payload: { correlationId, mediaAssetId: media },
        subject: { kind: "media-asset", mediaAssetId: mediaAssetId(media) },
        timeoutMs: 5_000,
        maxAttempts: 1,
        backoffBaseMs: 20,
      });
      await runNextJob(deps, queueName, spec("failPermanent"));

      const parsed = jsonLines(lines);
      const messages = parsed.map((line) => line["message"]);
      assert.deepEqual(messages, [
        "job.started",
        "job.retrying",
        "job.started",
        "job.finished",
        "job.started",
        "job.cancelled",
        "job.started",
        "job.failed",
      ]);
      for (const line of parsed) {
        assert.equal(line["correlationId"], correlationId);
        assert.equal(line["service"], "media-worker");
        assert.equal(line["subjectId"], media);
      }
      const statuses = await pool.query<{ id: string; status: string }>(
        "SELECT id, status FROM jobs WHERE id = ANY($1::uuid[])",
        [[retryId, cancelId, failId]],
      );
      const byId = new Map(statuses.rows.map((row) => [row.id, row.status]));
      assert.equal(byId.get(retryId), "Completed");
      assert.equal(byId.get(cancelId), "Cancelled");
      assert.equal(byId.get(failId), "Failed");
    } finally {
      await queue.close();
      await pool.end();
    }
  },
);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function untilStatus(
  deps: RunJobDeps,
  queueName: string,
  handler: IsolatedHandler,
  id: string,
  wanted: string,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    await runNextJob(deps, queueName, handler);
    const job = await deps.jobs.findById(jobId(id));
    if (job?.status === wanted) {
      return;
    }
    await delay(25);
  }
  const job = await deps.jobs.findById(jobId(id));
  throw new Error(`job ${id} stayed ${job?.status ?? "missing"}, wanted ${wanted}`);
}

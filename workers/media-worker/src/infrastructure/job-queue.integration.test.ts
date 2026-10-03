/**
 * Real Redis and Postgres proof for US-129.
 * The Python process reads the BullMQ hash Node wrote. That is the envelope contract.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createUuidV7, JobAttempt, type JobEnvelope, jobId, mediaAssetId } from "@editagent/domain";
import { Redis } from "ioredis";
import { Pool } from "pg";

import { cancelJob, enqueueJob, runNextJob } from "../application/run-job.js";
import { type IsolatedHandler } from "../application/job-supervisor.js";
import { BullMqJobQueue } from "./bullmq-job-queue.js";
import { ChildProcessJobSupervisor } from "./child-job-supervisor.js";
import { PostgresJobRepository } from "./postgres-job-repository.js";
import { isolatedRedisUrl, uniqueQueueSuffix } from "./test-redis.js";

const handlerModule = path.join(__dirname, "../handlers/sample-handlers.js");

function spec(exportName: string): IsolatedHandler {
  return { modulePath: handlerModule, exportName };
}

const TEST_DATABASE = "editagent_us129";
const redisUrl = isolatedRedisUrl(1, process.env["REDIS_URL"]);
const repoRoot = path.resolve(__dirname, "../../../..");

function adminUrl(): string {
  return (
    process.env.DATABASE_URL ??
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function subject(media: string) {
  return { kind: "media-asset" as const, mediaAssetId: mediaAssetId(media) };
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 8_000) {
    if (await check()) {
      return;
    }
    await delay(20);
  }
  throw new Error("condition was not met in time");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function pythonEnvelope(queueName: string, id: string): string {
  const result = spawnSync(
    "uv",
    [
      "run",
      "--project",
      "workers/ai-worker",
      "python",
      "-m",
      "editagent_ai_worker.infrastructure.read_envelope",
      redisUrl,
      queueName,
      id,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

test("queue contracts hold on Redis and Postgres", { timeout: 90_000 }, async () => {
  const admin = new Pool({ connectionString: adminUrl() });
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
  await admin.end();
  const pool = new Pool({ connectionString: withDatabase(adminUrl(), TEST_DATABASE) });
  const queue = new BullMqJobQueue(redisUrl);
  const jobs = new PostgresJobRepository(pool);
  const now = clock();
  const media = newId();
  const queueName = `jobs-${uniqueQueueSuffix()}`;
  const supervisor = new ChildProcessJobSupervisor();
  const deps = { jobs, queue, now, newAttemptId: newId, supervisor };
  try {
    await applyJobMigration(pool);

    const firstId = newId();
    const enqueued = await enqueueJob(deps, {
      id: firstId,
      queueName,
      jobType: "probe",
      idempotencyKey: `probe-${firstId}`,
      payload: { mediaAssetId: media },
      subject: subject(media),
      timeoutMs: 5_000,
      maxAttempts: 2,
      backoffBaseMs: 400,
    });
    assert.equal(enqueued.duplicate, false);
    const duplicate = await enqueueJob(deps, {
      id: newId(),
      queueName,
      jobType: "probe",
      idempotencyKey: `probe-${firstId}`,
      payload: { mediaAssetId: media },
      subject: subject(media),
      timeoutMs: 5_000,
      maxAttempts: 2,
      backoffBaseMs: 400,
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.jobId, firstId);
    const fromPython = JSON.parse(pythonEnvelope(queueName, firstId)) as JobEnvelope;
    assert.equal(fromPython.schemaVersion, 1);
    assert.equal(fromPython.jobId, firstId);
    assert.equal(fromPython.jobType, "probe");
    assert.equal(fromPython.subject.kind, "media-asset");
    assert.equal(fromPython.attempt, 1);
    assert.deepEqual(fromPython.payload, { mediaAssetId: media });
    const stored = await pool.query<{ payload: { mediaAssetId: string } }>(
      "SELECT payload FROM jobs WHERE id = $1",
      [firstId],
    );
    assert.deepEqual(stored.rows[0]?.payload, { mediaAssetId: media });

    const transient = spec("failTransient");
    await runNextJob(deps, queueName, transient);
    assert.equal((await jobs.findById(jobId(firstId)))?.status, "Retrying");
    assert.equal(await runNextJob(deps, queueName, transient), "idle");
    await drive(deps, queueName, transient, firstId, "Completed");
    const completed = await jobs.findById(jobId(firstId));
    assert.equal(completed?.status, "Completed");
    assert.equal(completed?.failureReason, null);
    const history = await jobs.listAttempts(jobId(firstId));
    assert.equal(history.length, 2);
    assert.equal(history[0]?.reason, "blip");
    assert.equal(history[1]?.status, "Completed");

    const permanentId = newId();
    await enqueueJob(deps, {
      id: permanentId,
      queueName,
      jobType: "probe",
      idempotencyKey: `permanent-${permanentId}`,
      payload: { mediaAssetId: media },
      subject: subject(media),
      timeoutMs: 5_000,
      maxAttempts: 3,
      backoffBaseMs: 20,
    });
    await drive(deps, queueName, spec("failPermanent"), permanentId, "Failed");
    const failed = await jobs.findById(jobId(permanentId));
    assert.equal(failed?.status, "Failed");
    assert.equal(failed?.failureReason, "disk corrupt");
    const letter = await jobs.findDeadLetter(jobId(permanentId));
    assert.equal(letter?.reason, "disk corrupt");
    assert.match(letter?.envelopeJson ?? "", /probe/);

    const cancelId = newId();
    await enqueueJob(deps, {
      id: cancelId,
      queueName,
      jobType: "probe",
      idempotencyKey: `cancel-${cancelId}`,
      payload: { mediaAssetId: media },
      subject: subject(media),
      timeoutMs: 30_000,
      maxAttempts: 1,
      backoffBaseMs: 20,
    });
    const running = runNextJob(deps, queueName, spec("cooperativeCancel"));
    await waitFor(async () => (await jobs.findById(jobId(cancelId)))?.status === "Running");
    const cancelStarted = Date.now();
    await cancelJob(deps, cancelId);
    await running;
    assert.ok(Date.now() - cancelStarted < 5_000);
    assert.equal((await jobs.findById(jobId(cancelId)))?.status, "Cancelled");

    const raceId = newId();
    await enqueueJob(deps, {
      id: raceId,
      queueName,
      jobType: "probe",
      idempotencyKey: `race-${raceId}`,
      payload: {},
      subject: subject(media),
      timeoutMs: 5_000,
      maxAttempts: 1,
      backoffBaseMs: 20,
    });
    await cancelJob(deps, raceId);
    const raced = await runNextJob(deps, queueName, spec("succeed"));
    assert.equal(raced, "idle");
    assert.equal((await jobs.findById(jobId(raceId)))?.status, "Cancelled");

    const delayedCancelId = newId();
    await enqueueJob(deps, {
      id: delayedCancelId,
      queueName,
      jobType: "probe",
      idempotencyKey: `delayed-${delayedCancelId}`,
      payload: { reason: "later" },
      subject: subject(media),
      timeoutMs: 5_000,
      maxAttempts: 3,
      backoffBaseMs: 5_000,
    });
    await runNextJob(deps, queueName, spec("failAlways"));
    assert.equal((await jobs.findById(jobId(delayedCancelId)))?.status, "Retrying");
    await cancelJob(deps, delayedCancelId);
    await delay(300);
    assert.equal(await runNextJob(deps, queueName, spec("succeed")), "idle");
    assert.equal((await jobs.findById(jobId(delayedCancelId)))?.status, "Cancelled");

    const timeoutId = newId();
    await enqueueJob(deps, {
      id: timeoutId,
      queueName,
      jobType: "probe",
      idempotencyKey: `timeout-${timeoutId}`,
      payload: {},
      subject: subject(media),
      timeoutMs: 80,
      maxAttempts: 1,
      backoffBaseMs: 20,
    });
    await drive(deps, queueName, spec("cooperativeCancel"), timeoutId, "Failed");
    assert.match((await jobs.findById(jobId(timeoutId)))?.failureReason ?? "", /timed out/);

    const exhaustId = newId();
    await enqueueJob(deps, {
      id: exhaustId,
      queueName,
      jobType: "probe",
      idempotencyKey: `exhaust-${exhaustId}`,
      payload: {},
      subject: subject(media),
      timeoutMs: 5_000,
      maxAttempts: 2,
      backoffBaseMs: 15,
    });
    await drive(deps, queueName, spec("failAlways"), exhaustId, "Failed");
    const exhausted = await jobs.listAttempts(jobId(exhaustId));
    assert.equal(exhausted.length, 2);
    assert.equal((await jobs.findDeadLetter(jobId(exhaustId)))?.reason, "still broken");

    const crashId = newId();
    await enqueueJob(deps, {
      id: crashId,
      queueName,
      jobType: "probe",
      idempotencyKey: `crash-${crashId}`,
      payload: { ok: true },
      subject: subject(media),
      timeoutMs: 5_000,
      maxAttempts: 2,
      backoffBaseMs: 20,
    });
    const claimed = await queue.reserve(queueName);
    assert.equal(claimed?.envelope.jobId, crashId);
    const claimedJob = await jobs.findById(jobId(crashId));
    assert.ok(claimedJob);
    const startedJob = claimedJob.start(now());
    await jobs.save(startedJob);
    await jobs.appendAttempt(
      JobAttempt.start(newId(), crashId, startedJob.attemptCount, startedJob.updatedAt),
    );
    const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    await redis.del(`bull:${queueName}:${crashId}:lock`);
    await redis.quit();
    await queue.close();
    const crashQueue = new BullMqJobQueue(redisUrl);
    try {
      await drive(
        { jobs, queue: crashQueue, now, newAttemptId: newId, supervisor },
        queueName,
        spec("succeed"),
        crashId,
        "Completed",
      );
      const crashHistory = await jobs.listAttempts(jobId(crashId));
      assert.equal(crashHistory.length, 2);
      assert.equal(crashHistory[0]?.status, "Retrying");
      assert.equal(crashHistory[0]?.reason, "worker failed");
      assert.equal(crashHistory[1]?.status, "Completed");
    } finally {
      await crashQueue.close();
    }

    const recoverId = newId();
    const holdingQueue = new BullMqJobQueue(redisUrl);
    await enqueueJob(
      { jobs, queue: holdingQueue, now, newAttemptId: newId, supervisor },
      {
        id: recoverId,
        queueName,
        jobType: "probe",
        idempotencyKey: `recover-${recoverId}`,
        payload: { ok: true },
        subject: subject(media),
        timeoutMs: 5_000,
        maxAttempts: 1,
        backoffBaseMs: 20,
      },
    );
    await holdingQueue.close();
    const recoveredQueue = new BullMqJobQueue(redisUrl);
    try {
      await drive(
        { jobs, queue: recoveredQueue, now, newAttemptId: newId, supervisor },
        queueName,
        spec("succeed"),
        recoverId,
        "Completed",
      );
      assert.equal((await jobs.listAttempts(jobId(recoverId))).length, 1);
    } finally {
      await recoveredQueue.close();
    }
  } finally {
    await queue.close().catch(() => undefined);
    await pool.end();
  }
});

async function drive(
  deps: {
    jobs: PostgresJobRepository;
    queue: BullMqJobQueue;
    now: () => bigint;
    newAttemptId: () => string;
    supervisor: ChildProcessJobSupervisor;
  },
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

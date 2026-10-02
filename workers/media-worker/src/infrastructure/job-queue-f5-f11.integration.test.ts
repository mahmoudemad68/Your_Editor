/**
 * Final QA repairs: atomic completion settlement and execution after lock loss.
 * PostgreSQL and Redis are real. The supervisor case does not need either.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createUuidV7,
  type Job,
  JobAttempt,
  type JobDeadLetter,
  type JobEnvelope,
  type JobId,
  type JobRepository,
  jobId,
  mediaAssetId,
} from "@editagent/domain";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { Pool } from "pg";

import { LockLostError } from "../application/job-errors.js";
import { enqueueJob, runNextJob, type RunJobDeps } from "../application/run-job.js";
import { BullMqJobQueue } from "./bullmq-job-queue.js";
import { ChildProcessJobSupervisor } from "./child-job-supervisor.js";
import { PostgresJobRepository } from "./postgres-job-repository.js";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379/0";
const repoRoot = path.resolve(__dirname, "../../../..");
const handlerModule = path.join(__dirname, "../handlers/sample-handlers.js");

class AckFails extends BullMqJobQueue {
  override async complete(): Promise<void> {
    throw new Error("ack down");
  }
}

function adminUrl(): string {
  return (
    process.env.DATABASE_URL ??
    "postgresql://editagent:editagent-dev-password@127.0.0.1:5432/editagent"
  );
}

function databaseUrl(database: string): string {
  const parsed = new URL(adminUrl());
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function subject(media: string) {
  return { kind: "media-asset" as const, mediaAssetId: mediaAssetId(media) };
}

function envelope(): JobEnvelope {
  return {
    schemaVersion: 1,
    jobId: newId(),
    queueName: "supervisor",
    jobType: "probe",
    idempotencyKey: "supervisor",
    payload: {},
    timeoutMs: 1_000,
    maxAttempts: 1,
    attempt: 1,
    backoffBaseMs: 20,
    subject: { kind: "media-asset", id: newId() },
  };
}

function countJobChildren(): number {
  let count = 0;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const command = readFileSync(`/proc/${entry}/cmdline`).toString("utf8");
      if (command.includes("job-child.js")) {
        count += 1;
      }
    } catch {
      // The process exited while we were reading.
    }
  }
  return count;
}

async function withDatabase(suffix: string, body: (pool: Pool) => Promise<void>): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(suffix)) {
    throw new Error(`unsafe database suffix ${suffix}`);
  }
  const database = `editagent_us129_${suffix}`;
  const admin = new Pool({ connectionString: adminUrl() });
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  const pool = new Pool({ connectionString: databaseUrl(database) });
  try {
    await pool.query(
      await readFile(path.join(repoRoot, "apps/api/migrations/0005_jobs.sql"), "utf8"),
    );
    await body(pool);
  } finally {
    await pool.end();
    const cleanup = new Pool({ connectionString: adminUrl() });
    await cleanup.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await cleanup.end();
  }
}

function depsFor(jobs: JobRepository, queue: BullMqJobQueue): RunJobDeps {
  return {
    jobs,
    queue,
    supervisor: new ChildProcessJobSupervisor(),
    now: clock(),
    newAttemptId: newId,
  };
}

function delegating(jobs: PostgresJobRepository): JobRepository {
  return {
    findById: (id: JobId) => jobs.findById(id),
    findByIdempotencyKey: (key: string) => jobs.findByIdempotencyKey(key),
    save: (job: Job) => jobs.save(job),
    appendAttempt: (attempt: JobAttempt) => jobs.appendAttempt(attempt),
    recordCompletion: (job: Job, attempt: JobAttempt) => jobs.recordCompletion(job, attempt),
    listAttempts: (id: JobId) => jobs.listAttempts(id),
    saveDeadLetter: (letter: JobDeadLetter) => jobs.saveDeadLetter(letter),
    findDeadLetter: (id: JobId) => jobs.findDeadLetter(id),
  };
}

async function markerText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function bullState(queueName: string, id: string): Promise<string> {
  const queue = new Queue(queueName, {
    connection: { url: redisUrl, maxRetriesPerRequest: null },
    prefix: "bull",
  });
  try {
    const job = await queue.getJob(id);
    return job ? await job.getState() : "missing";
  } finally {
    await queue.close();
  }
}

async function enqueueProbe(
  deps: RunJobDeps,
  queueName: string,
  id: string,
  payload: Readonly<Record<string, unknown>>,
  timeoutMs = 5_000,
): Promise<void> {
  await enqueueJob(deps, {
    id,
    queueName,
    jobType: "probe",
    idempotencyKey: `f5-${id}`,
    payload,
    subject: subject(newId()),
    timeoutMs,
    maxAttempts: 1,
    backoffBaseMs: 20,
  });
}

test("an already aborted signal does not fork a job child", async () => {
  const supervisor = new ChildProcessJobSupervisor();
  const before = countJobChildren();
  const signal = AbortSignal.abort(new LockLostError());
  await assert.rejects(
    () =>
      supervisor.run(envelope(), { modulePath: handlerModule, exportName: "touchMarker" }, signal),
    (error: unknown) => error instanceof LockLostError,
  );
  assert.equal(countJobChildren(), before);
});

test(
  "completion ledger retries without running the handler twice",
  { timeout: 60_000 },
  async () => {
    await withDatabase("f5_retry", async (pool) => {
      const jobs = new PostgresJobRepository(pool);
      const queue = new BullMqJobQueue(redisUrl);
      const directory = await mkdtemp(path.join(tmpdir(), "us129-f5-"));
      const marker = path.join(directory, "ran");
      const queueName = `f5r-${newId().slice(0, 8)}`;
      const id = newId();
      let failures = 0;
      const flaky: JobRepository = {
        ...delegating(jobs),
        async recordCompletion(job: Job, attempt: JobAttempt) {
          if (failures === 0) {
            failures += 1;
            throw new Error("completion ledger down");
          }
          await jobs.recordCompletion(job, attempt);
        },
      };
      try {
        await enqueueProbe(depsFor(jobs, queue), queueName, id, { markerPath: marker });
        await runNextJob(depsFor(flaky, queue), queueName, {
          modulePath: handlerModule,
          exportName: "touchMarker",
        });
        assert.equal(failures, 1);
        assert.equal((await jobs.findById(jobId(id)))?.status, "Completed");
        assert.equal((await jobs.findById(jobId(id)))?.failureReason, null);
        const closed = (await jobs.listAttempts(jobId(id)))[0];
        assert.equal(closed?.status, "Completed");
        assert.equal(closed?.finishedAt == null, false);
        assert.equal(await markerText(marker), "ran\n");
        assert.equal(await bullState(queueName, id), "completed");
        await runNextJob(depsFor(jobs, queue), queueName, {
          modulePath: handlerModule,
          exportName: "touchMarker",
        });
        assert.equal(await markerText(marker), "ran\n");
        assert.notEqual((await jobs.findById(jobId(id)))?.status, "Retrying");
        assert.notEqual((await jobs.findById(jobId(id)))?.status, "Failed");
      } finally {
        await queue.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
);

test("either completion write rolls the transaction back", { timeout: 60_000 }, async () => {
  await withDatabase("f5_tx", async (pool) => {
    await pool.query(`
      CREATE TABLE editagent_completion_fault (kind text PRIMARY KEY);
      CREATE FUNCTION editagent_fail_completion() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'Completed'
           AND EXISTS (
             SELECT 1 FROM editagent_completion_fault WHERE kind = TG_TABLE_NAME
           ) THEN
          RAISE EXCEPTION 'completion % down', TG_TABLE_NAME;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER editagent_fail_job
      BEFORE UPDATE ON jobs
      FOR EACH ROW EXECUTE FUNCTION editagent_fail_completion();
      CREATE TRIGGER editagent_fail_attempt
      BEFORE INSERT OR UPDATE ON job_attempts
      FOR EACH ROW EXECUTE FUNCTION editagent_fail_completion();
    `);
    const jobs = new PostgresJobRepository(pool);
    const queue = new BullMqJobQueue(redisUrl);
    const queueName = `f5t-${newId().slice(0, 8)}`;
    const id = newId();
    const now = clock();
    try {
      await enqueueProbe(depsFor(jobs, queue), queueName, id, { ok: true });
      const queued = await jobs.findById(jobId(id));
      assert.ok(queued);
      const running = queued.start(now());
      await jobs.save(running);
      const open = JobAttempt.start(newId(), running.id, running.attemptCount, running.updatedAt);
      await jobs.appendAttempt(open);
      const finishedAt = now();
      const completed = running.complete(finishedAt);
      const closed = open.finish("Completed", finishedAt, null);

      await pool.query("INSERT INTO editagent_completion_fault (kind) VALUES ('jobs')");
      await assert.rejects(() => jobs.recordCompletion(completed, closed), /completion jobs down/);
      assert.equal((await jobs.findById(jobId(id)))?.status, "Running");
      assert.equal((await jobs.listAttempts(jobId(id)))[0]?.finishedAt ?? null, null);

      await pool.query("DELETE FROM editagent_completion_fault");
      await pool.query("INSERT INTO editagent_completion_fault (kind) VALUES ('job_attempts')");
      await assert.rejects(
        () => jobs.recordCompletion(completed, closed),
        /completion job_attempts down/,
      );
      assert.equal((await jobs.findById(jobId(id)))?.status, "Running");
      assert.equal((await jobs.listAttempts(jobId(id)))[0]?.status, "Running");
      assert.equal((await jobs.listAttempts(jobId(id)))[0]?.finishedAt ?? null, null);

      await pool.query("DELETE FROM editagent_completion_fault");
      await jobs.recordCompletion(completed, closed);
      assert.equal((await jobs.findById(jobId(id)))?.status, "Completed");
      assert.equal((await jobs.findById(jobId(id)))?.updatedAt, finishedAt);
      const stored = (await jobs.listAttempts(jobId(id)))[0];
      assert.equal(stored?.status, "Completed");
      assert.equal(stored?.finishedAt, finishedAt);
      assert.equal(stored?.attemptNumber, completed.attemptCount);
    } finally {
      await queue.close();
    }
  });
});

test(
  "an acknowledgement failure is recovered without a second execution",
  { timeout: 60_000 },
  async () => {
    await withDatabase("f5_ack", async (pool) => {
      const jobs = new PostgresJobRepository(pool);
      const queue = new AckFails(redisUrl, { lockDurationMs: 400, stalledIntervalMs: 150 });
      const directory = await mkdtemp(path.join(tmpdir(), "us129-f5-"));
      const marker = path.join(directory, "ran");
      const queueName = `f5a-${newId().slice(0, 8)}`;
      const id = newId();
      try {
        await enqueueProbe(depsFor(jobs, queue), queueName, id, { markerPath: marker });
        await runNextJob(depsFor(jobs, queue), queueName, {
          modulePath: handlerModule,
          exportName: "touchMarker",
        });
        assert.equal((await jobs.findById(jobId(id)))?.status, "Completed");
        assert.equal((await jobs.findById(jobId(id)))?.failureReason, null);
        assert.equal((await jobs.listAttempts(jobId(id)))[0]?.status, "Completed");
        assert.equal((await jobs.listAttempts(jobId(id)))[0]?.finishedAt == null, false);
        assert.equal(await markerText(marker), "ran\n");
        assert.equal(await bullState(queueName, id), "active");
        await queue.close();
        await delay(700);
        const recovered = new BullMqJobQueue(redisUrl, {
          lockDurationMs: 400,
          stalledIntervalMs: 150,
        });
        try {
          const started = Date.now();
          let state = "active";
          while (state !== "completed" && Date.now() - started < 8_000) {
            await runNextJob(depsFor(jobs, recovered), queueName, {
              modulePath: handlerModule,
              exportName: "touchMarker",
            });
            state = await bullState(queueName, id);
            await delay(100);
          }
          assert.equal(state, "completed");
        } finally {
          await recovered.close();
        }
        assert.equal(await markerText(marker), "ran\n");
        assert.equal((await jobs.findById(jobId(id)))?.status, "Completed");
        assert.equal((await jobs.listAttempts(jobId(id))).length, 1);
        assert.equal((await jobs.listAttempts(jobId(id)))[0]?.status, "Completed");
      } finally {
        await queue.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
);

test(
  "a completed job with an open attempt is reconciled before ack",
  { timeout: 60_000 },
  async () => {
    await withDatabase("f5_open", async (pool) => {
      const jobs = new PostgresJobRepository(pool);
      const queue = new BullMqJobQueue(redisUrl);
      const directory = await mkdtemp(path.join(tmpdir(), "us129-f5-"));
      const marker = path.join(directory, "ran");
      const queueName = `f5o-${newId().slice(0, 8)}`;
      const id = newId();
      const now = clock();
      const deps = {
        jobs,
        queue,
        supervisor: new ChildProcessJobSupervisor(),
        now,
        newAttemptId: newId,
      };
      try {
        await enqueueProbe(deps, queueName, id, { markerPath: marker });
        const queued = await jobs.findById(jobId(id));
        assert.ok(queued);
        const running = queued.start(now());
        await jobs.save(running);
        await jobs.appendAttempt(
          JobAttempt.start(newId(), running.id, running.attemptCount, running.updatedAt),
        );
        await jobs.save(running.complete(now()));
        await runNextJob(deps, queueName, {
          modulePath: handlerModule,
          exportName: "touchMarker",
        });
        assert.equal(await markerText(marker), null);
        assert.equal((await jobs.findById(jobId(id)))?.status, "Completed");
        const stored = (await jobs.listAttempts(jobId(id)))[0];
        assert.equal(stored?.status, "Completed");
        assert.equal(stored?.finishedAt == null, false);
        assert.equal(await bullState(queueName, id), "completed");
      } finally {
        await queue.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
);

test("lock loss during findById does not start the handler", { timeout: 60_000 }, async () => {
  await withDatabase("f11_early", async (pool) => {
    const jobs = new PostgresJobRepository(pool);
    const queue = new BullMqJobQueue(redisUrl, { lockDurationMs: 200, stalledIntervalMs: 100 });
    const directory = await mkdtemp(path.join(tmpdir(), "us129-f11-"));
    const marker = path.join(directory, "ran");
    const queueName = `f11-${newId().slice(0, 8)}`;
    const id = newId();
    let notified = false;
    const originalLost = queue.whenLockLost.bind(queue);
    queue.whenLockLost = (receipt, notify) => {
      originalLost(receipt, () => {
        notified = true;
        notify();
      });
    };
    const slow: JobRepository = {
      ...delegating(jobs),
      async findById(job: JobId) {
        if (job === id) {
          const redis = new Redis(redisUrl);
          await redis.del(`bull:${queueName}:${id}:lock`);
          await redis.quit();
          await delay(800);
        }
        return jobs.findById(job);
      },
    };
    try {
      await enqueueProbe(depsFor(jobs, queue), queueName, id, { markerPath: marker });
      const before = countJobChildren();
      await runNextJob(depsFor(slow, queue), queueName, {
        modulePath: handlerModule,
        exportName: "touchMarker",
      });
      await delay(200);
      assert.equal(notified, true);
      assert.equal(await markerText(marker), null);
      assert.equal((await jobs.findById(jobId(id)))?.status, "Queued");
      assert.equal((await jobs.listAttempts(jobId(id))).length, 0);
      assert.equal(countJobChildren(), before);
      await queue.close();
      const recovered = new BullMqJobQueue(redisUrl, {
        lockDurationMs: 400,
        stalledIntervalMs: 100,
      });
      try {
        const started = Date.now();
        let status = (await jobs.findById(jobId(id)))?.status;
        while (status !== "Completed" && Date.now() - started < 8_000) {
          await runNextJob(depsFor(jobs, recovered), queueName, {
            modulePath: handlerModule,
            exportName: "touchMarker",
          });
          status = (await jobs.findById(jobId(id)))?.status;
          await delay(100);
        }
        assert.equal(status, "Completed");
      } finally {
        await recovered.close();
      }
      assert.equal(await markerText(marker), "ran\n");
      assert.equal((await jobs.listAttempts(jobId(id))).length, 1);
      assert.equal((await jobs.listAttempts(jobId(id)))[0]?.status, "Completed");
      assert.equal(await bullState(queueName, id), "completed");
    } finally {
      await queue.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

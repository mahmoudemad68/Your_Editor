/**
 * Regressions for the Codex review of US-129.
 * Each test uses Redis and PostgreSQL. Python cases run the real BullMQ client.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createUuidV7,
  type Job,
  type JobAttempt,
  type JobDeadLetter,
  type JobEnvelope,
  type JobId,
  type JobRepository,
  jobId,
  mediaAssetId,
} from "@editagent/domain";
import { Queue, type Job as BullJob } from "bullmq";
import { Redis } from "ioredis";
import { Pool } from "pg";

import { IdempotencyConflictError } from "../application/job-errors.js";
import { enqueueJob, runNextJob, type RunJobDeps } from "../application/run-job.js";
import { BullMqJobQueue } from "./bullmq-job-queue.js";
import { ChildProcessJobSupervisor } from "./child-job-supervisor.js";
import { PostgresJobRepository } from "./postgres-job-repository.js";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379/0";
const repoRoot = path.resolve(__dirname, "../../../..");
const handlerModule = path.join(__dirname, "../handlers/sample-handlers.js");

class UpdateDataFails extends BullMqJobQueue {
  protected override async persistReservedEnvelope(
    _job: BullJob,
    _envelope: JobEnvelope,
  ): Promise<void> {
    throw new Error("redis update failed");
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

async function withDatabase(
  suffix: string,
  body: (pool: Pool, url: string) => Promise<void>,
): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(suffix)) {
    throw new Error(`unsafe database suffix ${suffix}`);
  }
  const database = `editagent_us129_${suffix}`;
  const admin = new Pool({ connectionString: adminUrl() });
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  const url = databaseUrl(database);
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query(
      await readFile(path.join(repoRoot, "apps/api/migrations/0005_jobs.sql"), "utf8"),
    );
    await body(pool, url);
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

function pythonArgs(url: string, queueName: string, lockMs: number): string[] {
  return [
    "run",
    "--project",
    "workers/ai-worker",
    "python",
    "-m",
    "editagent_ai_worker.infrastructure.consume_job",
    redisUrl,
    url,
    queueName,
    "consume",
    String(lockMs),
  ];
}

function python(url: string, queueName: string, lockMs: number) {
  return spawnSync("uv", pythonArgs(url, queueName, lockMs), {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 20_000,
  });
}

function pythonChild(url: string, queueName: string, lockMs: number): ChildProcess {
  return spawn("uv", pythonArgs(url, queueName, lockMs), { cwd: repoRoot });
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

async function markerText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

test("idempotency conflict keeps the stored payload", { timeout: 60_000 }, async () => {
  await withDatabase("codex_idem", async (pool) => {
    const jobs = new PostgresJobRepository(pool);
    const queue = new BullMqJobQueue(redisUrl);
    const media = newId();
    const queueName = `idem-${newId().slice(0, 8)}`;
    const idempotencyKey = `idem-${newId()}`;
    const storedId = newId();
    const racingJobs: JobRepository = {
      findById: (id: JobId) => jobs.findById(id),
      async findByIdempotencyKey(key: string) {
        return jobs.findByIdempotencyKey(key);
      },
      async save(job: Job) {
        await jobs.save(job);
        if (job.idempotencyKey === idempotencyKey && job.status === "Queued") {
          throw Object.assign(new Error("winner crashed after insert"), { code: "CRASH" });
        }
      },
      appendAttempt: (attempt: JobAttempt) => jobs.appendAttempt(attempt),
      listAttempts: (id: JobId) => jobs.listAttempts(id),
      saveDeadLetter: (letter: JobDeadLetter) => jobs.saveDeadLetter(letter),
      findDeadLetter: (id: JobId) => jobs.findDeadLetter(id),
    };
    const work = {
      queueName,
      jobType: "probe",
      idempotencyKey,
      subject: subject(media),
      timeoutMs: 1_000,
      maxAttempts: 1,
      backoffBaseMs: 20,
    };
    await assert.rejects(
      () =>
        enqueueJob(depsFor(racingJobs, queue), {
          ...work,
          id: storedId,
          payload: { n: 1 },
        }),
      /winner crashed after insert/,
    );
    const redis = new Redis(redisUrl);
    try {
      await assert.rejects(
        () =>
          enqueueJob(depsFor(racingJobs, queue), {
            ...work,
            id: newId(),
            payload: { n: 2 },
          }),
        (error: unknown) => error instanceof IdempotencyConflictError,
      );
      assert.equal(await redis.exists(`bull:${queueName}:${storedId}`), 0);
      assert.deepEqual((await jobs.findByIdempotencyKey(idempotencyKey))?.payload, { n: 1 });
      const republished = await enqueueJob(depsFor(racingJobs, queue), {
        ...work,
        id: newId(),
        payload: { n: 1 },
      });
      assert.equal(republished.duplicate, true);
      assert.equal(republished.jobId, storedId);
      const raw = await redis.hget(`bull:${queueName}:${storedId}`, "data");
      assert.equal(raw == null, false);
      assert.deepEqual(JSON.parse(raw ?? "{}").payload, { n: 1 });
      await assert.rejects(
        () =>
          enqueueJob(depsFor(racingJobs, queue), {
            ...work,
            id: newId(),
            queueName: `other-${newId().slice(0, 8)}`,
            payload: { n: 1 },
          }),
        (error: unknown) => error instanceof IdempotencyConflictError,
      );
    } finally {
      await redis.quit();
      await queue.close();
    }
  });
});

test("a ledger failure after success does not fail the job", { timeout: 60_000 }, async () => {
  await withDatabase("codex_ledger", async (pool) => {
    const jobs = new PostgresJobRepository(pool);
    const queue = new BullMqJobQueue(redisUrl, { lockDurationMs: 400, stalledIntervalMs: 150 });
    const directory = await mkdtemp(path.join(tmpdir(), "us129-codex-"));
    const marker = path.join(directory, "ran");
    const queueName = `ledger-${newId().slice(0, 8)}`;
    const id = newId();
    const flaky: JobRepository = {
      findById: (job: JobId) => jobs.findById(job),
      findByIdempotencyKey: (key: string) => jobs.findByIdempotencyKey(key),
      save: (job: Job) => jobs.save(job),
      async appendAttempt(attempt: JobAttempt) {
        if (attempt.status === "Completed") {
          throw new Error("attempt ledger down");
        }
        await jobs.appendAttempt(attempt);
      },
      listAttempts: (job: JobId) => jobs.listAttempts(job),
      saveDeadLetter: (letter: JobDeadLetter) => jobs.saveDeadLetter(letter),
      findDeadLetter: (job: JobId) => jobs.findDeadLetter(job),
    };
    try {
      await enqueueJob(depsFor(jobs, queue), {
        id,
        queueName,
        jobType: "probe",
        idempotencyKey: `ledger-${id}`,
        payload: { markerPath: marker },
        subject: subject(newId()),
        timeoutMs: 5_000,
        maxAttempts: 1,
        backoffBaseMs: 20,
      });
      await assert.rejects(
        () =>
          runNextJob(depsFor(flaky, queue), queueName, {
            modulePath: handlerModule,
            exportName: "touchMarker",
          }),
        /attempt ledger down/,
      );
      assert.equal((await jobs.findById(jobId(id)))?.status, "Completed");
      assert.equal((await jobs.findById(jobId(id)))?.failureReason, null);
      assert.equal(await markerText(marker), "ran\n");
      assert.equal(await bullState(queueName, id), "active");
      await queue.close();
      await delay(500);
      const recovered = new BullMqJobQueue(redisUrl, {
        lockDurationMs: 400,
        stalledIntervalMs: 150,
      });
      try {
        const started = Date.now();
        let state = await bullState(queueName, id);
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
      assert.equal(await jobs.findDeadLetter(jobId(id)), null);
    } finally {
      await queue.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test(
  "a late lock listener fires and the reservation cannot be acked",
  { timeout: 60_000 },
  async () => {
    await withDatabase("codex_lock", async (pool) => {
      const jobs = new PostgresJobRepository(pool);
      const queue = new BullMqJobQueue(redisUrl, { lockDurationMs: 200, stalledIntervalMs: 100 });
      const queueName = `late-${newId().slice(0, 8)}`;
      const id = newId();
      try {
        await enqueueJob(depsFor(jobs, queue), {
          id,
          queueName,
          jobType: "probe",
          idempotencyKey: `late-${id}`,
          payload: { ok: true },
          subject: subject(newId()),
          timeoutMs: 5_000,
          maxAttempts: 1,
          backoffBaseMs: 20,
        });
        const reserved = await queue.reserve(queueName);
        assert.ok(reserved);
        const redis = new Redis(redisUrl);
        await redis.del(`bull:${queueName}:${id}:lock`);
        await redis.quit();
        await delay(800);
        let notified = false;
        queue.whenLockLost(reserved.receipt, () => {
          notified = true;
        });
        assert.equal(notified, true);
        await assert.rejects(() => queue.complete(reserved.receipt), /not reserved/);
      } finally {
        await queue.close();
      }
    });
  },
);

test(
  "an envelope write failure is not recorded as an invalid envelope",
  { timeout: 60_000 },
  async () => {
    await withDatabase("codex_update", async (pool) => {
      const jobs = new PostgresJobRepository(pool);
      const failing = new UpdateDataFails(redisUrl);
      const queueName = `upd-${newId().slice(0, 8)}`;
      const id = newId();
      const directory = await mkdtemp(path.join(tmpdir(), "us129-codex-"));
      const marker = path.join(directory, "ran");
      try {
        await enqueueJob(depsFor(jobs, failing), {
          id,
          queueName,
          jobType: "probe",
          idempotencyKey: `upd-${id}`,
          payload: { markerPath: marker },
          subject: subject(newId()),
          timeoutMs: 5_000,
          maxAttempts: 1,
          backoffBaseMs: 20,
        });
        await assert.rejects(
          () =>
            runNextJob(depsFor(jobs, failing), queueName, {
              modulePath: handlerModule,
              exportName: "touchMarker",
            }),
          /redis update failed/,
        );
        assert.equal((await jobs.findById(jobId(id)))?.status, "Queued");
        assert.equal(await jobs.findDeadLetter(jobId(id)), null);
        assert.equal(await markerText(marker), null);
        assert.equal(await bullState(queueName, id), "waiting");
        await failing.close();
        const recovered = new BullMqJobQueue(redisUrl);
        try {
          await runNextJob(depsFor(jobs, recovered), queueName, {
            modulePath: handlerModule,
            exportName: "touchMarker",
          });
        } finally {
          await recovered.close();
        }
        assert.equal(await markerText(marker), "ran\n");
        assert.equal((await jobs.findById(jobId(id)))?.status, "Completed");
      } finally {
        await failing.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
);

test("Python timeout and cancel stop the hold before the marker", { timeout: 60_000 }, async () => {
  await withDatabase("codex_pyguard", async (pool, url) => {
    const jobs = new PostgresJobRepository(pool);
    const queue = new BullMqJobQueue(redisUrl);
    const directory = await mkdtemp(path.join(tmpdir(), "us129-codex-"));
    const timeoutMarker = path.join(directory, "timeout");
    const cancelMarker = path.join(directory, "cancel");
    const timeoutQueue = `pyt-${newId().slice(0, 8)}`;
    const cancelQueue = `pyc-${newId().slice(0, 8)}`;
    const timeoutId = newId();
    const cancelId = newId();
    const work = subject(newId());
    try {
      await enqueueJob(depsFor(jobs, queue), {
        id: timeoutId,
        queueName: timeoutQueue,
        jobType: "probe",
        idempotencyKey: `pyt-${timeoutId}`,
        payload: { mode: "hold", delayMs: 8_000, markerPath: timeoutMarker },
        subject: work,
        timeoutMs: 400,
        maxAttempts: 1,
        backoffBaseMs: 20,
      });
      const timed = python(url, timeoutQueue, 5_000);
      assert.equal(timed.status, 0, `${timed.stdout}\n${timed.stderr}`);
      assert.match(timed.stdout, /"status": "Failed"/);
      assert.equal((await jobs.findById(jobId(timeoutId)))?.status, "Failed");
      assert.match((await jobs.findById(jobId(timeoutId)))?.failureReason ?? "", /timed out/);
      assert.match((await jobs.findDeadLetter(jobId(timeoutId)))?.reason ?? "", /timed out/);
      assert.equal(await bullState(timeoutQueue, timeoutId), "failed");
      assert.equal(await markerText(timeoutMarker), null);

      await enqueueJob(depsFor(jobs, queue), {
        id: cancelId,
        queueName: cancelQueue,
        jobType: "probe",
        idempotencyKey: `pyc-${cancelId}`,
        payload: { mode: "hold", delayMs: 8_000, markerPath: cancelMarker },
        subject: work,
        timeoutMs: 20_000,
        maxAttempts: 1,
        backoffBaseMs: 20,
      });
      const child = pythonChild(url, cancelQueue, 5_000);
      const started = Date.now();
      while ((await jobs.findById(jobId(cancelId)))?.status !== "Running") {
        if (Date.now() - started > 8_000) {
          child.kill("SIGKILL");
          throw new Error("python consumer did not start the cancelled job");
        }
        await delay(20);
      }
      const redis = new Redis(redisUrl);
      const cancelStarted = Date.now();
      await redis.set(`editagent:job-cancel:${cancelId}`, "1");
      await redis.quit();
      const exitCode = await new Promise<number | null>((resolve) => {
        child.once("exit", (code) => {
          resolve(code);
        });
      });
      const cancelMs = Date.now() - cancelStarted;
      console.log(`python cancel ${cancelMs}ms`);
      assert.equal(exitCode, 0);
      assert.ok(cancelMs < 5_000, `python cancel took ${cancelMs}ms`);
      assert.equal((await jobs.findById(jobId(cancelId)))?.status, "Cancelled");
      assert.equal(await bullState(cancelQueue, cancelId), "completed");
      assert.equal(await markerText(cancelMarker), null);
    } finally {
      await queue.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test(
  "Python persists terminal state before acknowledging BullMQ",
  { timeout: 60_000 },
  async () => {
    await withDatabase("codex_pyack", async (pool, url) => {
      const jobs = new PostgresJobRepository(pool);
      const queue = new BullMqJobQueue(redisUrl);
      const queueName = `pyack-${newId().slice(0, 8)}`;
      const id = newId();
      try {
        await pool.query(`
        CREATE FUNCTION editagent_block_complete() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.status = 'Completed' AND OLD.status IS DISTINCT FROM 'Completed' THEN
            RAISE EXCEPTION 'block complete';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER editagent_block_complete
        BEFORE UPDATE ON jobs
        FOR EACH ROW EXECUTE FUNCTION editagent_block_complete();
      `);
        await enqueueJob(depsFor(jobs, queue), {
          id,
          queueName,
          jobType: "probe",
          idempotencyKey: `pyack-${id}`,
          payload: { mode: "ok" },
          subject: subject(newId()),
          timeoutMs: 5_000,
          maxAttempts: 1,
          backoffBaseMs: 20,
        });
        const consumed = python(url, queueName, 5_000);
        assert.equal(consumed.status, 1, `${consumed.stdout}\n${consumed.stderr}`);
        assert.match(consumed.stderr, /block complete/);
        assert.equal((await jobs.findById(jobId(id)))?.status, "Running");
        assert.notEqual(await bullState(queueName, id), "completed");
      } finally {
        await queue.close();
      }
    });
  },
);

test(
  "Python settles an invalid envelope and a final crashed attempt",
  { timeout: 60_000 },
  async () => {
    await withDatabase("codex_pyfail", async (pool, url) => {
      const jobs = new PostgresJobRepository(pool);
      const queue = new BullMqJobQueue(redisUrl);
      const directory = await mkdtemp(path.join(tmpdir(), "us129-codex-"));
      const marker = path.join(directory, "crash");
      const badQueue = `pybad-${newId().slice(0, 8)}`;
      const crashQueue = `pycrash-${newId().slice(0, 8)}`;
      const badId = newId();
      const crashId = newId();
      try {
        await enqueueJob(depsFor(jobs, queue), {
          id: badId,
          queueName: badQueue,
          jobType: "probe",
          idempotencyKey: `pybad-${badId}`,
          payload: { mode: "ok" },
          subject: subject(newId()),
          timeoutMs: 5_000,
          maxAttempts: 1,
          backoffBaseMs: 20,
        });
        const raw = new Redis(redisUrl);
        await raw.hset(`bull:${badQueue}:${badId}`, "data", JSON.stringify({ schemaVersion: 1 }));
        await raw.quit();
        const invalid = python(url, badQueue, 5_000);
        assert.equal(invalid.status, 0, `${invalid.stdout}\n${invalid.stderr}`);
        assert.equal((await jobs.findById(jobId(badId)))?.status, "Failed");
        assert.match(
          (await jobs.findById(jobId(badId)))?.failureReason ?? "",
          /does not match the shared JSON Schema/,
        );
        assert.match((await jobs.findDeadLetter(jobId(badId)))?.reason ?? "", /JSON Schema/);
        assert.equal(await bullState(badQueue, badId), "failed");

        await enqueueJob(depsFor(jobs, queue), {
          id: crashId,
          queueName: crashQueue,
          jobType: "probe",
          idempotencyKey: `pycrash-${crashId}`,
          payload: { mode: "hold", delayMs: 8_000, markerPath: marker },
          subject: subject(newId()),
          timeoutMs: 20_000,
          maxAttempts: 1,
          backoffBaseMs: 20,
        });
        const victim = spawn("uv", pythonArgs(url, crashQueue, 700), {
          cwd: repoRoot,
          detached: true,
        });
        const started = Date.now();
        while ((await jobs.findById(jobId(crashId)))?.status !== "Running") {
          if (Date.now() - started > 8_000) {
            if (victim.pid != null) {
              process.kill(-victim.pid, "SIGKILL");
            }
            throw new Error("python consumer did not start the crashed job");
          }
          await delay(20);
        }
        if (victim.pid == null) {
          throw new Error("python consumer pid is missing");
        }
        process.kill(-victim.pid, "SIGKILL");
        await new Promise((resolve) => {
          victim.once("exit", resolve);
        });
        let recovered = (await jobs.findById(jobId(crashId)))?.status;
        const recoverStarted = Date.now();
        while (recovered !== "Failed" && Date.now() - recoverStarted < 15_000) {
          python(url, crashQueue, 700);
          recovered = (await jobs.findById(jobId(crashId)))?.status;
          await delay(100);
        }
        assert.equal(recovered, "Failed");
        assert.match((await jobs.findDeadLetter(jobId(crashId)))?.reason ?? "", /worker failed/);
        assert.equal(await markerText(marker), null);
        assert.equal(await bullState(crashQueue, crashId), "failed");
      } finally {
        await queue.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
);

test(
  "Python renews the lock while job history is still starting",
  { timeout: 60_000 },
  async () => {
    await withDatabase("codex_pyrenew", async (pool, url) => {
      const jobs = new PostgresJobRepository(pool);
      const queue = new BullMqJobQueue(redisUrl);
      const directory = await mkdtemp(path.join(tmpdir(), "us129-codex-"));
      const marker = path.join(directory, "renew");
      const queueName = `pyren-${newId().slice(0, 8)}`;
      const id = newId();
      try {
        await pool.query(`
        CREATE FUNCTION editagent_slow_start() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.status = 'Running' AND OLD.status IS DISTINCT FROM 'Running' THEN
            PERFORM pg_sleep(1.2);
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER editagent_slow_start
        BEFORE UPDATE ON jobs
        FOR EACH ROW EXECUTE FUNCTION editagent_slow_start();
      `);
        await enqueueJob(depsFor(jobs, queue), {
          id,
          queueName,
          jobType: "probe",
          idempotencyKey: `pyren-${id}`,
          payload: { mode: "hold", delayMs: 200, markerPath: marker },
          subject: subject(newId()),
          timeoutMs: 10_000,
          maxAttempts: 2,
          backoffBaseMs: 20,
        });
        const first = pythonChild(url, queueName, 400);
        const redis = new Redis(redisUrl);
        const ownedAt = Date.now();
        while ((await redis.exists(`bull:${queueName}:${id}:lock`)) !== 1) {
          if (Date.now() - ownedAt > 8_000) {
            first.kill("SIGKILL");
            await redis.quit();
            throw new Error("python consumer did not lock the slow job");
          }
          await delay(20);
        }
        await redis.quit();
        const second = python(url, queueName, 400);
        const exitCode = await new Promise<number | null>((resolve) => {
          first.once("exit", (code) => {
            resolve(code);
          });
        });
        assert.equal(exitCode, 0);
        assert.equal(second.status, 3, `${second.stdout}\n${second.stderr}`);
        assert.match(second.stdout, /idle/);
        assert.equal((await jobs.findById(jobId(id)))?.status, "Completed");
        assert.equal(await markerText(marker), "done 200\n");
        assert.equal((await jobs.listAttempts(jobId(id))).length, 1);
      } finally {
        await queue.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
);

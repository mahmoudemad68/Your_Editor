/**
 * TypeScript enqueue, Python BullMQ reserve, execute, and complete.
 * PostgreSQL is updated by the Python consumer, not by a Redis hash read.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createUuidV7, jobId, mediaAssetId } from "@editagent/domain";
import { Queue } from "bullmq";
import { Pool } from "pg";

import { enqueueJob } from "../application/run-job.js";
import { BullMqJobQueue } from "./bullmq-job-queue.js";
import { ChildProcessJobSupervisor } from "./child-job-supervisor.js";
import { PostgresJobRepository } from "./postgres-job-repository.js";
import { isolatedRedisUrl, uniqueQueueSuffix } from "./test-redis.js";

const TEST_DATABASE = "editagent_us129_py";
const redisUrl = isolatedRedisUrl(3, process.env["REDIS_URL"]);
const repoRoot = path.resolve(__dirname, "../../../..");

function adminUrl(): string {
  return (
    process.env.DATABASE_URL ??
    "postgresql://editagent:editagent-dev-password@127.0.0.1:5432/editagent"
  );
}

function databaseUrl(): string {
  const parsed = new URL(adminUrl());
  parsed.pathname = `/${TEST_DATABASE}`;
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

function python(action: "consume" | "probe", queueName: string, lockMs?: number) {
  return spawnSync(
    "uv",
    [
      "run",
      "--project",
      "workers/ai-worker",
      "python",
      "-m",
      "editagent_ai_worker.infrastructure.consume_job",
      redisUrl,
      databaseUrl(),
      queueName,
      action,
      ...(lockMs === undefined ? [] : [String(lockMs)]),
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
}

test("Python consumes a job enqueued by TypeScript", { timeout: 90_000 }, async () => {
  const admin = new Pool({ connectionString: adminUrl() });
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
  await admin.end();
  const pool = new Pool({ connectionString: databaseUrl() });
  await pool.query(
    await readFile(path.join(repoRoot, "apps/api/migrations/0005_jobs.sql"), "utf8"),
  );
  const jobs = new PostgresJobRepository(pool);
  const queue = new BullMqJobQueue(redisUrl);
  const now = clock();
  const media = newId();
  const queueName = `py-${uniqueQueueSuffix()}`;
  const deps = {
    jobs,
    queue,
    supervisor: new ChildProcessJobSupervisor(),
    now,
    newAttemptId: newId,
  };
  const directory = await mkdtemp(path.join(tmpdir(), "us129-py-"));
  try {
    const subject = { kind: "media-asset" as const, mediaAssetId: mediaAssetId(media) };
    const okId = newId();
    await enqueueJob(deps, {
      id: okId,
      queueName,
      jobType: "probe",
      idempotencyKey: `ok-${okId}`,
      payload: { mode: "ok" },
      subject,
      timeoutMs: 5_000,
      maxAttempts: 1,
      backoffBaseMs: 20,
    });
    const consumed = python("consume", queueName);
    assert.equal(consumed.status, 0, `${consumed.stdout}\n${consumed.stderr}`);
    assert.equal((await jobs.findById(jobId(okId)))?.status, "Completed");
    assert.equal((await jobs.listAttempts(jobId(okId))).length, 1);
    const bull = new Queue(queueName, {
      connection: { url: redisUrl, maxRetriesPerRequest: null },
      prefix: "bull",
    });
    const bullJob = await bull.getJob(okId);
    assert.equal(bullJob ? await bullJob.getState() : "missing", "completed");
    await bull.close();

    const retryId = newId();
    await enqueueJob(deps, {
      id: retryId,
      queueName,
      jobType: "probe",
      idempotencyKey: `retry-${retryId}`,
      payload: { mode: "transient" },
      subject,
      timeoutMs: 5_000,
      maxAttempts: 2,
      backoffBaseMs: 30,
    });
    const first = python("consume", queueName);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    assert.equal((await jobs.findById(jobId(retryId)))?.status, "Retrying");
    let retryStatus = "Retrying";
    const retryStarted = Date.now();
    while (retryStatus !== "Completed" && Date.now() - retryStarted < 8_000) {
      const again = python("consume", queueName);
      if (again.status === 0) {
        retryStatus = (await jobs.findById(jobId(retryId)))?.status ?? retryStatus;
      }
      await delay(40);
    }
    assert.equal(retryStatus, "Completed");
    assert.equal((await jobs.listAttempts(jobId(retryId))).length, 2);
    assert.equal((await jobs.listAttempts(jobId(retryId)))[0]?.reason, "blip");

    const permanentId = newId();
    await enqueueJob(deps, {
      id: permanentId,
      queueName,
      jobType: "probe",
      idempotencyKey: `permanent-${permanentId}`,
      payload: { mode: "permanent" },
      subject,
      timeoutMs: 5_000,
      maxAttempts: 3,
      backoffBaseMs: 20,
    });
    const permanent = python("consume", queueName);
    assert.equal(permanent.status, 0, `${permanent.stdout}\n${permanent.stderr}`);
    assert.equal((await jobs.findById(jobId(permanentId)))?.status, "Failed");
    assert.equal((await jobs.findById(jobId(permanentId)))?.failureReason, "disk corrupt");
    assert.equal((await jobs.findDeadLetter(jobId(permanentId)))?.reason, "disk corrupt");

    const marker = path.join(directory, "hold");
    const holdId = newId();
    await enqueueJob(deps, {
      id: holdId,
      queueName,
      jobType: "probe",
      idempotencyKey: `hold-${holdId}`,
      payload: { mode: "hold", delayMs: 1_200, markerPath: marker },
      subject,
      timeoutMs: 10_000,
      maxAttempts: 1,
      backoffBaseMs: 20,
    });
    const holder = spawn(
      "uv",
      [
        "run",
        "--project",
        "workers/ai-worker",
        "python",
        "-m",
        "editagent_ai_worker.infrastructure.consume_job",
        redisUrl,
        databaseUrl(),
        queueName,
        "consume",
        "4000",
      ],
      { cwd: repoRoot },
    );
    const holdStarted = Date.now();
    while ((await jobs.findById(jobId(holdId)))?.status !== "Running") {
      if (Date.now() - holdStarted > 8_000) {
        holder.kill("SIGKILL");
        throw new Error("python consumer did not start the held job");
      }
      await delay(20);
    }
    const probe = python("probe", queueName, 4000);
    assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
    assert.match(probe.stdout, /idle/);
    const holdExit = await new Promise<number>((resolve, reject) => {
      holder.once("exit", (code) => resolve(code ?? 1));
      holder.once("error", reject);
    });
    assert.equal(holdExit, 0);
    assert.equal((await jobs.findById(jobId(holdId)))?.status, "Completed");
    assert.match(await readFile(marker, "utf8"), /done 1200/);

    const crashMarker = path.join(directory, "crash");
    const crashId = newId();
    await enqueueJob(deps, {
      id: crashId,
      queueName,
      jobType: "probe",
      idempotencyKey: `crash-${crashId}`,
      payload: { mode: "hold", delayMs: 8_000, markerPath: crashMarker },
      subject,
      timeoutMs: 30_000,
      maxAttempts: 2,
      backoffBaseMs: 20,
    });
    const victim = spawn(
      "uv",
      [
        "run",
        "--project",
        "workers/ai-worker",
        "python",
        "-m",
        "editagent_ai_worker.infrastructure.consume_job",
        redisUrl,
        databaseUrl(),
        queueName,
        "consume",
        "700",
      ],
      { cwd: repoRoot },
    );
    const crashStarted = Date.now();
    while ((await jobs.findById(jobId(crashId)))?.status !== "Running") {
      if (Date.now() - crashStarted > 8_000) {
        victim.kill("SIGKILL");
        throw new Error("python consumer did not start the interrupted job");
      }
      await delay(20);
    }
    victim.kill("SIGKILL");
    await new Promise((resolve) => victim.once("exit", resolve));
    let recovered = (await jobs.findById(jobId(crashId)))?.status;
    const recoverStarted = Date.now();
    while (recovered !== "Completed" && Date.now() - recoverStarted < 20_000) {
      python("consume", queueName, 700);
      recovered = (await jobs.findById(jobId(crashId)))?.status;
      await delay(100);
    }
    assert.equal(recovered, "Completed");
    const crashText = await readFile(crashMarker, "utf8");
    assert.equal(crashText.trim().split("\n").length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await queue.close();
    await pool.end();
  }
});

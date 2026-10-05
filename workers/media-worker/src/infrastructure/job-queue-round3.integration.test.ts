/**
 * Round-3 regressions: process-group cancellation, Python lock loss, and a
 * failed cancel check before the handler starts.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createUuidV7, jobId, mediaAssetId, type JobEnvelope } from "@editagent/domain";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { Pool } from "pg";

import { cancelJob, enqueueJob, runNextJob } from "../application/run-job.js";
import { JobTimeoutError } from "../application/job-errors.js";
import { BullMqJobQueue } from "./bullmq-job-queue.js";
import { ChildProcessJobSupervisor } from "./child-job-supervisor.js";
import { PostgresJobRepository } from "./postgres-job-repository.js";
import { isolatedRedisUrl, uniqueQueueSuffix } from "./test-redis.js";

const TEST_DATABASE = "editagent_us129_round3";
const redisUrl = isolatedRedisUrl(4, process.env["REDIS_URL"]);
const repoRoot = path.resolve(__dirname, "../../../..");
const handlerModule = path.join(__dirname, "../handlers/sample-handlers.js");

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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function markerText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function waitForDescendant(pidPath: string): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const pid = Number(await markerText(pidPath));
    // writeFile creates the file before writing its contents. An empty file
    // is not readiness: PID 0 would probe the test's own process group.
    if (Number.isSafeInteger(pid) && pid > 1) {
      return pid;
    }
    await delay(10);
  }
  throw new Error("descendant did not start");
}

function pythonConsume(
  queueName: string,
  lockMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(
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
      String(lockMs),
    ],
    { cwd: repoRoot },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

test("round 3 blockers stay fixed on Redis and Postgres", { timeout: 60_000 }, async () => {
  const admin = new Pool({ connectionString: adminUrl() });
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
  await admin.end();
  const pool = new Pool({ connectionString: databaseUrl() });
  await pool.query(
    await readFile(path.join(repoRoot, "apps/api/migrations/0005_jobs.sql"), "utf8"),
  );
  const jobs = new PostgresJobRepository(pool);
  const queue = new BullMqJobQueue(redisUrl, { lockDurationMs: 500, stalledIntervalMs: 200 });
  const supervisor = new ChildProcessJobSupervisor();
  const now = clock();
  const media = newId();
  const subject = { kind: "media-asset" as const, mediaAssetId: mediaAssetId(media) };
  const deps = { jobs, queue, supervisor, now, newAttemptId: newId };
  const directory = await mkdtemp(path.join(tmpdir(), "us129-round3-"));
  try {
    const cancelMarker = path.join(directory, "cancel");
    const cancelPid = path.join(directory, "cancel-pid");
    const cancelQueue = `grp-${uniqueQueueSuffix()}`;
    const cancelId = newId();
    await enqueueJob(deps, {
      id: cancelId,
      queueName: cancelQueue,
      jobType: "probe",
      idempotencyKey: `grp-${cancelId}`,
      payload: { markerPath: cancelMarker, pidPath: cancelPid, delayMs: 2_500 },
      subject,
      timeoutMs: 30_000,
      maxAttempts: 1,
      backoffBaseMs: 20,
    });
    const cancelRun = runNextJob(deps, cancelQueue, {
      modulePath: handlerModule,
      exportName: "spawnDescendant",
    });
    const descendant = await waitForDescendant(cancelPid);
    const cancelStarted = Date.now();
    await cancelJob(deps, cancelId);
    await cancelRun;
    const cancelMs = Date.now() - cancelStarted;
    console.log(`descendant cancel ${cancelMs}ms`);
    assert.ok(cancelMs < 5_000, `descendant cancel took ${cancelMs}ms`);
    assert.equal(alive(descendant), false);
    assert.equal((await jobs.findById(jobId(cancelId)))?.status, "Cancelled");
    await delay(2_600);
    assert.equal(await markerText(cancelMarker), null);
    assert.equal(alive(descendant), false);

    const timeoutMarker = path.join(directory, "timeout");
    const timeoutQueue = `to-${uniqueQueueSuffix()}`;
    const timeoutId = newId();
    await enqueueJob(deps, {
      id: timeoutId,
      queueName: timeoutQueue,
      jobType: "probe",
      idempotencyKey: `to-${timeoutId}`,
      payload: { markerPath: timeoutMarker, delayMs: 2_500 },
      subject,
      timeoutMs: 180,
      maxAttempts: 1,
      backoffBaseMs: 20,
    });
    const timeoutStarted = Date.now();
    await runNextJob(deps, timeoutQueue, {
      modulePath: handlerModule,
      exportName: "spawnDescendant",
    });
    const timeoutMs = Date.now() - timeoutStarted;
    console.log(`descendant timeout ${timeoutMs}ms`);
    assert.ok(timeoutMs < 5_000, `descendant timeout took ${timeoutMs}ms`);
    assert.equal((await jobs.findById(jobId(timeoutId)))?.status, "Failed");
    assert.match((await jobs.findById(jobId(timeoutId)))?.failureReason ?? "", /timed out/);
    await delay(2_600);
    assert.equal(await markerText(timeoutMarker), null);

    const touch = path.join(directory, "touch");
    const checkQueue = `chk-${uniqueQueueSuffix()}`;
    const checkId = newId();
    await enqueueJob(deps, {
      id: checkId,
      queueName: checkQueue,
      jobType: "probe",
      idempotencyKey: `chk-${checkId}`,
      payload: { markerPath: touch },
      subject,
      timeoutMs: 5_000,
      maxAttempts: 1,
      backoffBaseMs: 20,
    });
    const unhandled: string[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error instanceof Error ? error.message : String(error));
    };
    process.on("unhandledRejection", onUnhandled);
    queue.isCancelRequested = async () => {
      throw new Error("cancel check failed");
    };
    const checked = await runNextJob(deps, checkQueue, {
      modulePath: handlerModule,
      exportName: "touchMarker",
    });
    await delay(700);
    process.off("unhandledRejection", onUnhandled);
    assert.equal(checked, "done");
    assert.deepEqual(unhandled, []);
    assert.equal(await markerText(touch), null);
    assert.equal((await jobs.findById(jobId(checkId)))?.status, "Queued");
    const redis = new Redis(redisUrl);
    assert.equal(await redis.exists(`bull:${checkQueue}:${checkId}:lock`), 0);
    assert.equal(await redis.lpos(`bull:${checkQueue}:active`, checkId), null);
    await redis.quit();
    queue.isCancelRequested = BullMqJobQueue.prototype.isCancelRequested.bind(queue);
    const recovered = new BullMqJobQueue(redisUrl);
    try {
      await runNextJob(
        { jobs, queue: recovered, supervisor, now, newAttemptId: newId },
        checkQueue,
        { modulePath: handlerModule, exportName: "touchMarker" },
      );
    } finally {
      await recovered.close();
    }
    assert.equal(await markerText(touch), "ran\n");
    assert.equal((await jobs.findById(jobId(checkId)))?.status, "Completed");

    const pyMarker = path.join(directory, "py-lock");
    const pyQueue = `pyl-${uniqueQueueSuffix()}`;
    const pyId = newId();
    await enqueueJob(deps, {
      id: pyId,
      queueName: pyQueue,
      jobType: "probe",
      idempotencyKey: `pyl-${pyId}`,
      payload: { mode: "hold", delayMs: 2_500, markerPath: pyMarker },
      subject,
      timeoutMs: 20_000,
      maxAttempts: 2,
      backoffBaseMs: 20,
    });
    const lost = await (async () => {
      const running = pythonConsume(pyQueue, 300);
      while ((await jobs.findById(jobId(pyId)))?.status !== "Running") {
        await delay(15);
      }
      const lockRedis = new Redis(redisUrl);
      await lockRedis.del(`bull:${pyQueue}:${pyId}:lock`);
      await lockRedis.quit();
      return running;
    })();
    assert.equal(lost.code, 0, `${lost.stdout}\n${lost.stderr}`);
    assert.match(lost.stdout, /lock-lost/);
    assert.equal(await markerText(pyMarker), null);
    const recoverStarted = Date.now();
    let sawPair = false;
    while ((await jobs.findById(jobId(pyId)))?.status !== "Completed") {
      if (Date.now() - recoverStarted > 15_000) {
        break;
      }
      const pair = await Promise.all([
        pythonConsume(pyQueue, 5_000),
        pythonConsume(pyQueue, 5_000),
      ]);
      sawPair = true;
      const completedRuns = pair.filter((result) => result.stdout.includes("completed")).length;
      assert.ok(completedRuns <= 1, pair.map((result) => result.stdout).join("\n"));
    }
    assert.equal(sawPair, true);
    assert.equal((await markerText(pyMarker))?.trim().split("\n").length, 1);
    assert.equal((await jobs.findById(jobId(pyId)))?.status, "Completed");
    const bull = new Queue(pyQueue, {
      connection: { url: redisUrl, maxRetriesPerRequest: null },
      prefix: "bull",
    });
    const bullJob = await bull.getJob(pyId);
    assert.equal(bullJob ? await bullJob.getState() : "missing", "completed");
    await bull.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
    await queue.close();
    await pool.end();
  }
});

test("a timeout reaps a handler and its running descendant", { timeout: 20_000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "us129-timeout-group-"));
  const marker = path.join(directory, "timeout");
  const pidPath = path.join(directory, "timeout-pid");
  const controller = new AbortController();
  const envelope: JobEnvelope = {
    schemaVersion: 1,
    jobId: newId(),
    queueName: `timeout-${uniqueQueueSuffix()}`,
    jobType: "probe",
    idempotencyKey: newId(),
    payload: { markerPath: marker, pidPath, delayMs: 2_500 },
    subject: { kind: "media-asset", id: newId() },
    timeoutMs: 180,
    maxAttempts: 1,
    attempt: 1,
    backoffBaseMs: 20,
  };
  const stopped = assert.rejects(
    new ChildProcessJobSupervisor().run(
      envelope,
      { modulePath: handlerModule, exportName: "spawnDescendant" },
      controller.signal,
    ),
    JobTimeoutError,
  );
  t.after(async () => {
    controller.abort(new JobTimeoutError());
    await stopped;
    await rm(directory, { recursive: true, force: true });
  });

  // The application deadline above includes cold process startup. Exercise
  // live descendant teardown separately, after the child reports its PID.
  const descendant = await waitForDescendant(pidPath);
  assert.equal(alive(descendant), true);
  const timeoutStarted = Date.now();
  await delay(envelope.timeoutMs);
  controller.abort(new JobTimeoutError());
  await stopped;
  const timeoutMs = Date.now() - timeoutStarted;
  assert.ok(timeoutMs < 5_000, `descendant timeout took ${timeoutMs}ms`);
  assert.equal(alive(descendant), false);
  await delay(2_600);
  assert.equal(await markerText(marker), null);
  assert.equal(alive(descendant), false);
});

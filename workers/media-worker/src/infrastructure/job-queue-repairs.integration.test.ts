/**
 * Regressions for the US-129 QA failures.
 * Each test uses Redis and PostgreSQL. Cancellation checks the child process,
 * not only the Postgres status.
 */

import assert from "node:assert/strict";
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
  type JobId,
  type JobRepository,
  jobId,
  mediaAssetId,
} from "@editagent/domain";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { Pool } from "pg";

import { type IsolatedHandler } from "../application/job-supervisor.js";
import { cancelJob, enqueueJob, runNextJob } from "../application/run-job.js";
import { BullMqJobQueue } from "./bullmq-job-queue.js";
import { ChildProcessJobSupervisor } from "./child-job-supervisor.js";
import { PostgresJobRepository } from "./postgres-job-repository.js";

const TEST_DATABASE = "editagent_us129_repair";
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379/0";
const repoRoot = path.resolve(__dirname, "../../../..");
const handlerModule = path.join(__dirname, "../handlers/sample-handlers.js");

function spec(exportName: string): IsolatedHandler {
  return { modulePath: handlerModule, exportName };
}

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function subject(media: string) {
  return { kind: "media-asset" as const, mediaAssetId: mediaAssetId(media) };
}

async function markerExists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

test("QA repairs hold on Redis and Postgres", { timeout: 60_000 }, async () => {
  const admin = new Pool({ connectionString: adminUrl() });
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
  await admin.end();
  const pool = new Pool({ connectionString: withDatabase(adminUrl(), TEST_DATABASE) });
  const sql = await readFile(path.join(repoRoot, "apps/api/migrations/0005_jobs.sql"), "utf8");
  await pool.query(sql);
  const jobs = new PostgresJobRepository(pool);
  const queue = new BullMqJobQueue(redisUrl, { lockDurationMs: 600, stalledIntervalMs: 200 });
  const supervisor = new ChildProcessJobSupervisor();
  const now = clock();
  const media = newId();
  const queueName = `repair-${newId().slice(0, 8)}`;
  const deps = { jobs, queue, supervisor, now, newAttemptId: newId };
  const directory = await mkdtemp(path.join(tmpdir(), "us129-repair-"));
  try {
    const cooperativeMarker = path.join(directory, "cooperative");
    const cooperativeId = newId();
    await enqueueJob(deps, {
      id: cooperativeId,
      queueName,
      jobType: "probe",
      idempotencyKey: `coop-${cooperativeId}`,
      payload: { markerPath: cooperativeMarker },
      subject: subject(media),
      timeoutMs: 30_000,
      maxAttempts: 1,
      backoffBaseMs: 20,
    });
    const cooperativeRun = runNextJob(deps, queueName, spec("cooperativeCancel"));
    while ((await jobs.findById(jobId(cooperativeId)))?.status !== "Running") {
      await delay(10);
    }
    const cooperativeStarted = Date.now();
    await cancelJob(deps, cooperativeId);
    await cooperativeRun;
    assert.ok(Date.now() - cooperativeStarted < 5_000);
    assert.equal((await jobs.findById(jobId(cooperativeId)))?.status, "Cancelled");
    assert.equal(await readFile(cooperativeMarker, "utf8"), "stopped");

    const lateMarker = path.join(directory, "late");
    const lateId = newId();
    await enqueueJob(deps, {
      id: lateId,
      queueName,
      jobType: "probe",
      idempotencyKey: `late-${lateId}`,
      payload: { markerPath: lateMarker, delayMs: 2_500 },
      subject: subject(media),
      timeoutMs: 30_000,
      maxAttempts: 1,
      backoffBaseMs: 20,
    });
    const lateRun = runNextJob(deps, queueName, spec("nonCooperativeSideEffect"));
    while ((await jobs.findById(jobId(lateId)))?.status !== "Running") {
      await delay(10);
    }
    const lateStarted = Date.now();
    await cancelJob(deps, lateId);
    await lateRun;
    const lateStopped = Date.now() - lateStarted;
    assert.ok(lateStopped < 5_000);
    assert.equal((await jobs.findById(jobId(lateId)))?.status, "Cancelled");
    assert.equal(await markerExists(lateMarker), false);
    await delay(2_500);
    assert.equal(await markerExists(lateMarker), false);

    const timeoutMarker = path.join(directory, "timeout");
    const timeoutId = newId();
    await enqueueJob(deps, {
      id: timeoutId,
      queueName,
      jobType: "probe",
      idempotencyKey: `timeout-${timeoutId}`,
      payload: { markerPath: timeoutMarker, delayMs: 2_000 },
      subject: subject(media),
      timeoutMs: 150,
      maxAttempts: 1,
      backoffBaseMs: 20,
    });
    await runNextJob(deps, queueName, spec("nonCooperativeSideEffect"));
    assert.equal((await jobs.findById(jobId(timeoutId)))?.status, "Failed");
    assert.match((await jobs.findById(jobId(timeoutId)))?.failureReason ?? "", /timed out/);
    assert.equal(await markerExists(timeoutMarker), false);
    await delay(2_000);
    assert.equal(await markerExists(timeoutMarker), false);

    const spanMarker = path.join(directory, "span");
    const spanId = newId();
    const rival = new BullMqJobQueue(redisUrl, { lockDurationMs: 600, stalledIntervalMs: 200 });
    await enqueueJob(deps, {
      id: spanId,
      queueName,
      jobType: "probe",
      idempotencyKey: `span-${spanId}`,
      payload: { markerPath: spanMarker, delayMs: 1_600 },
      subject: subject(media),
      timeoutMs: 20_000,
      maxAttempts: 1,
      backoffBaseMs: 20,
    });
    const spanRun = runNextJob(deps, queueName, spec("recordSpan"));
    while ((await jobs.findById(jobId(spanId)))?.status !== "Running") {
      await delay(10);
    }
    const stolen: string[] = [];
    const rivalWatch = (async () => {
      const started = Date.now();
      while (Date.now() - started < 1_800) {
        const reserved = await rival.reserve(queueName);
        if (reserved) {
          stolen.push(reserved.envelope.jobId);
          await rival.complete(reserved.receipt);
        }
        await delay(100);
      }
    })();
    await spanRun;
    await rivalWatch;
    assert.deepEqual(stolen, []);
    const span = await readFile(spanMarker, "utf8");
    assert.equal(span.match(/start /g)?.length, 1);
    assert.equal(span.match(/end /g)?.length, 1);
    assert.equal((await jobs.findById(jobId(spanId)))?.status, "Completed");
    await rival.close();

    const lossMarker = path.join(directory, "loss");
    const lossId = newId();
    const lossQueue = new BullMqJobQueue(redisUrl, { lockDurationMs: 400, stalledIntervalMs: 150 });
    const lossDeps = { jobs, queue: lossQueue, supervisor, now, newAttemptId: newId };
    await enqueueJob(lossDeps, {
      id: lossId,
      queueName,
      jobType: "probe",
      idempotencyKey: `loss-${lossId}`,
      payload: { markerPath: lossMarker, delayMs: 8_000 },
      subject: subject(media),
      timeoutMs: 30_000,
      maxAttempts: 2,
      backoffBaseMs: 20,
    });
    const lossRun = runNextJob(lossDeps, queueName, spec("recordSpan"));
    while ((await jobs.findById(jobId(lossId)))?.status !== "Running") {
      await delay(10);
    }
    const lockRedis = new Redis(redisUrl);
    await lockRedis.del(`bull:${queueName}:${lossId}:lock`);
    await lockRedis.quit();
    await lossRun;
    assert.equal((await readFile(lossMarker, "utf8")).includes("end "), false);
    assert.notEqual((await jobs.findById(jobId(lossId)))?.status, "Completed");
    const recovery = new BullMqJobQueue(redisUrl, { lockDurationMs: 400, stalledIntervalMs: 150 });
    try {
      const started = Date.now();
      let status = (await jobs.findById(jobId(lossId)))?.status;
      while (status !== "Completed" && Date.now() - started < 8_000) {
        await runNextJob(
          { jobs, queue: recovery, supervisor, now, newAttemptId: newId },
          queueName,
          spec("succeed"),
        );
        status = (await jobs.findById(jobId(lossId)))?.status;
        await delay(50);
      }
      assert.equal(status, "Completed");
      const lossHistory = await jobs.listAttempts(jobId(lossId));
      assert.equal(lossHistory[0]?.reason, "worker failed");
      assert.equal((await readFile(lossMarker, "utf8")).includes("end "), false);
    } finally {
      await recovery.close();
    }
    await lossQueue.close();

    const idempotencyKey = `race-${newId()}`;
    let passedFind = 0;
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = () => {
        if (passedFind >= 2) {
          resolve();
        }
      };
    });
    const racingJobs: JobRepository = {
      async findByIdempotencyKey(idempotencyKeyValue: string) {
        const found = await jobs.findByIdempotencyKey(idempotencyKeyValue);
        if (!found && idempotencyKeyValue === idempotencyKey) {
          passedFind += 1;
          release();
          await barrier;
        }
        return found;
      },
      findById: (id: JobId) => jobs.findById(id),
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
    const leftId = newId();
    const rightId = newId();
    const raced = await Promise.allSettled([
      enqueueJob(
        { jobs: racingJobs, queue, supervisor, now, newAttemptId: newId },
        {
          id: leftId,
          queueName,
          jobType: "probe",
          idempotencyKey,
          payload: { n: 1 },
          subject: subject(media),
          timeoutMs: 1_000,
          maxAttempts: 1,
          backoffBaseMs: 20,
        },
      ),
      enqueueJob(
        { jobs: racingJobs, queue, supervisor, now, newAttemptId: newId },
        {
          id: rightId,
          queueName,
          jobType: "probe",
          idempotencyKey,
          payload: { n: 2 },
          subject: subject(media),
          timeoutMs: 1_000,
          maxAttempts: 1,
          backoffBaseMs: 20,
        },
      ),
    ]);
    const winner = await jobs.findByIdempotencyKey(idempotencyKey);
    assert.equal(winner?.status, "Queued");
    const redis = new Redis(redisUrl);
    const present = await redis.exists(`bull:${queueName}:${winner?.id ?? ""}`);
    await redis.quit();
    assert.equal(present, 1);
    assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);

    const badQueue = `bad-${newId().slice(0, 8)}`;
    const badId = newId();
    await enqueueJob(deps, {
      id: badId,
      queueName: badQueue,
      jobType: "probe",
      idempotencyKey: `bad-${badId}`,
      payload: { ok: true },
      subject: subject(media),
      timeoutMs: 1_000,
      maxAttempts: 1,
      backoffBaseMs: 20,
    });
    const raw = new Redis(redisUrl);
    await raw.hset(`bull:${badQueue}:${badId}`, "data", JSON.stringify({ schemaVersion: 1 }));
    await raw.quit();
    await runNextJob(deps, badQueue, spec("succeed"));
    assert.equal((await jobs.findById(jobId(badId)))?.status, "Failed");
    assert.match(
      (await jobs.findById(jobId(badId)))?.failureReason ?? "",
      /does not match the shared JSON Schema/,
    );
    const stateQueue = new Queue(badQueue, {
      connection: { url: redisUrl, maxRetriesPerRequest: null },
      prefix: "bull",
    });
    const bullJob = await stateQueue.getJob(badId);
    assert.equal(bullJob ? await bullJob.getState() : "missing", "failed");
    await stateQueue.close();
    assert.equal((await jobs.findDeadLetter(jobId(badId)))?.reason.includes("JSON Schema"), true);

    const unhandled: string[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error instanceof Error ? error.message : String(error));
    };
    process.on("unhandledRejection", onUnhandled);
    let checks = 0;
    const originalCancel = queue.isCancelRequested.bind(queue);
    queue.isCancelRequested = async (id: string) => {
      checks += 1;
      if (checks > 1) {
        throw new Error("cancel poll failed");
      }
      return originalCancel(id);
    };
    const pollQueue = `poll-${newId().slice(0, 8)}`;
    const pollId = newId();
    await enqueueJob(deps, {
      id: pollId,
      queueName: pollQueue,
      jobType: "probe",
      idempotencyKey: `poll-${pollId}`,
      payload: { delayMs: 350 },
      subject: subject(media),
      timeoutMs: 5_000,
      maxAttempts: 1,
      backoffBaseMs: 20,
    });
    await runNextJob(deps, pollQueue, spec("sleepBriefly"));
    await delay(100);
    process.off("unhandledRejection", onUnhandled);
    assert.deepEqual(unhandled, []);
    assert.equal((await jobs.findById(jobId(pollId)))?.status, "Completed");
  } finally {
    await rm(directory, { recursive: true, force: true });
    await queue.close();
    await pool.end();
  }
});

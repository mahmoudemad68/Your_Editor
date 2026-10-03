/**
 * HTTP upload completion publishes a durable job. The media-worker process
 * reserves that BullMQ job. This file reads Postgres, Redis, and both logs.
 */

import "reflect-metadata";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { test } from "node:test";
import path from "node:path";
import { createUuidV7, instant, mediaAssetId, projectId, userId } from "@editagent/domain";
import {
  BullMqJobQueue,
  observePostgresPool,
  PostgresJobRepository,
  publishMediaInspectJob,
} from "@editagent/job-queue";
import { createServiceLogger } from "@editagent/shared";
import { Redis } from "ioredis";
import { Pool } from "pg";

import {
  type Clock,
  type MediaAssetIdGenerator,
  type ProjectIdGenerator,
} from "./application/clock.js";
import { InMemoryMediaAssetRepository } from "./application/in-memory-media-repository.js";
import { InMemoryProjectRepository } from "./application/in-memory-project-repository.js";
import { MemoryObjectStorage } from "./application/memory-object-storage.js";
import { createApiApplication } from "./create-api-application.js";
import { applyMigrations } from "./infrastructure/migrate.js";
import { NodeMediaAssetIdGenerator } from "./infrastructure/node-media-asset-id-generator.js";
import { NodeProjectIdGenerator } from "./infrastructure/node-project-id-generator.js";
import { PostgresMediaAssetRepository } from "./infrastructure/postgres-media-repository.js";
import { PostgresProjectRepository } from "./infrastructure/postgres-project-repository.js";
import { S3ObjectStorage } from "./infrastructure/s3-object-storage.js";
import { SystemClock } from "./infrastructure/system-clock.js";
import { bindActor } from "./presentation/actor.js";

const TEST_DATABASE = "editagent_us115_queue";
const OWNER = userId("018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f");
const REQUEST_ID = "web-request-1";

function adminUrl(): string {
  return (
    process.env["DATABASE_URL"] ??
    "postgresql://editagent:editagent-dev-password@127.0.0.1:5432/editagent"
  );
}

function redisUrl(): string {
  return process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379/0";
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function storageConfig() {
  return {
    endpoint: process.env["S3_ENDPOINT"] ?? "http://127.0.0.1:9000",
    publicEndpoint: process.env["S3_PUBLIC_ENDPOINT"] ?? "http://127.0.0.1:9000",
    bucket: process.env["S3_BUCKET"] ?? "editagent",
    accessKeyId: process.env["S3_ACCESS_KEY_ID"] ?? "editagent",
    secretAccessKey: process.env["S3_SECRET_ACCESS_KEY"] ?? "editagent-dev-secret",
    region: process.env["S3_REGION"] ?? "us-east-1",
    presignTtlSeconds: 900,
  };
}

function jsonLines(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

class ManualClock implements Clock {
  now(): ReturnType<Clock["now"]> {
    return instant(10n);
  }
}

class OneId implements ProjectIdGenerator {
  next(): ReturnType<ProjectIdGenerator["next"]> {
    return projectId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f");
  }
}

class FixedMediaId implements MediaAssetIdGenerator {
  next(): ReturnType<MediaAssetIdGenerator["next"]> {
    return mediaAssetId("018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4f");
  }
}

test("ready checks dependencies and health does not", async () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString("utf8"));
      callback();
    },
  });
  const logger = createServiceLogger("api", stream);
  const app = await createApiApplication(
    {
      projects: new InMemoryProjectRepository(),
      clock: new ManualClock(),
      ids: new OneId(),
      media: new InMemoryMediaAssetRepository(),
      objects: new MemoryObjectStorage(),
      mediaIds: new FixedMediaId(),
      presignTtlSeconds: 900,
      logger,
      readiness: {
        async check(): Promise<boolean> {
          return false;
        },
      },
    },
    undefined,
    logger,
  );
  try {
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a TCP port");
    }
    const base = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", modules: 12 });
    const ready = await fetch(`${base}/ready`);
    assert.equal(ready.status, 503);
    assert.deepEqual(await ready.json(), { status: "not-ready" });
  } finally {
    await app.close();
  }
});

test(
  "upload completion reaches the media worker with one correlation id",
  { timeout: 60_000 },
  async () => {
    const queueName = `media${createUuidV7(Date.now(), randomBytes(10)).slice(0, 8)}`;
    const previousQueue = process.env["MEDIA_INSPECT_QUEUE"];
    process.env["MEDIA_INSPECT_QUEUE"] = queueName;
    const admin = new Pool({ connectionString: adminUrl() });
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
    await admin.end();
    const databaseUrl = withDatabase(adminUrl(), TEST_DATABASE);
    const pool = new Pool({ connectionString: databaseUrl });
    const redis = new Redis(redisUrl());
    const queue = new BullMqJobQueue(redisUrl());
    const jobs = new PostgresJobRepository(pool);
    const clock = new SystemClock();
    const objects = new S3ObjectStorage(storageConfig());
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString("utf8"));
        callback();
      },
    });
    const logger = createServiceLogger("api", stream);
    let worker: ChildProcess | undefined;
    let workerOut = "";
    let workerErr = "";
    let storageKey = "";
    const app = await createApiApplication(
      {
        projects: new PostgresProjectRepository(pool),
        clock,
        ids: new NodeProjectIdGenerator(),
        media: new PostgresMediaAssetRepository(pool),
        objects,
        mediaIds: new NodeMediaAssetIdGenerator(),
        presignTtlSeconds: 900,
        logger,
        readiness: {
          async check(): Promise<boolean> {
            try {
              await pool.query("SELECT 1");
              return (await redis.ping()) === "PONG";
            } catch {
              return false;
            }
          },
        },
        inspectJobs: {
          async publish(assetId: string, correlationId: string): Promise<void> {
            await publishMediaInspectJob(
              {
                jobs,
                queue,
                supervisor: {
                  async run(): Promise<void> {
                    throw new Error("The API does not run jobs.");
                  },
                },
                now: () => clock.now(),
                newAttemptId: () => createUuidV7(Date.now(), randomBytes(10)),
              },
              {
                jobId: createUuidV7(Date.now(), randomBytes(10)),
                mediaAssetId: assetId,
                correlationId,
                queueName,
              },
            );
          },
        },
      },
      (use) => {
        use((request, _response, next) => {
          const headers = (request as { headers?: Record<string, string | undefined> }).headers;
          const header = headers?.["x-test-actor"];
          if (typeof header === "string") {
            bindActor(request, userId(header));
          }
          next();
        });
      },
      logger,
    );
    try {
      await applyMigrations(pool);
      await objects.ensureBucket();
      observePostgresPool(pool, () => undefined);
      await app.listen(0, "127.0.0.1");
      const address = app.getHttpServer().address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a TCP port");
      }
      const base = `http://127.0.0.1:${address.port}`;
      const health = await fetch(`${base}/health`);
      assert.equal(health.status, 200);
      const ready = await fetch(`${base}/ready`);
      assert.equal(ready.status, 200);
      assert.deepEqual(await ready.json(), { status: "ready" });
      const created = await fetch(`${base}/projects`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-actor": OWNER,
          "x-request-id": REQUEST_ID,
        },
        body: JSON.stringify({ name: "Launch" }),
      });
      const createdText = await created.text();
      assert.equal(created.status, 201, createdText);
      const project = JSON.parse(createdText) as { id: string };
      const body = Buffer.from(`editagent-fixture-video-${queueName}`);
      const hash = createHash("sha256").update(body).digest("hex");
      const started = await fetch(`${base}/projects/${project.id}/uploads`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-actor": OWNER,
          "x-request-id": REQUEST_ID,
        },
        body: JSON.stringify({
          filename: "lecture.mp4",
          mimeType: "video/mp4",
          byteSize: body.byteLength,
          sha256: hash,
        }),
      });
      const startedText = await started.text();
      assert.equal(started.status, 201, startedText);
      const upload = JSON.parse(startedText) as {
        uploadUrl: string;
        storageKey: string;
        requiredHeaders: Record<string, string>;
      };
      storageKey = upload.storageKey;
      const put = await fetch(upload.uploadUrl, {
        method: "PUT",
        headers: upload.requiredHeaders,
        body,
      });
      assert.equal(put.status, 200, await put.text());
      const completed = await fetch(`${base}/projects/${project.id}/uploads/complete`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-actor": OWNER,
          "x-request-id": REQUEST_ID,
        },
        body: JSON.stringify({
          filename: "lecture.mp4",
          mimeType: "video/mp4",
          byteSize: body.byteLength,
          sha256: hash,
        }),
      });
      const completedText = await completed.text();
      assert.equal(completed.status, 201, completedText);
      const asset = JSON.parse(completedText) as { id: string };
      const queued = await pool.query<{
        id: string;
        status: string;
        payload: { correlationId?: string };
      }>("SELECT id, status, payload FROM jobs WHERE idempotency_key = $1", [
        `media.inspect.${asset.id}`,
      ]);
      assert.equal(queued.rowCount, 1);
      const jobId = queued.rows[0]?.id;
      assert.equal(typeof jobId, "string");
      assert.equal(queued.rows[0]?.status, "Queued");
      assert.equal(queued.rows[0]?.payload.correlationId, REQUEST_ID);
      const stored = await redis.hget(`bull:${queueName}:${jobId}`, "data");
      assert.equal(typeof stored, "string");
      const envelope = JSON.parse(stored ?? "{}") as {
        correlationId?: string;
        payload?: { correlationId?: string; mediaAssetId?: string };
        jobType?: string;
      };
      assert.equal(envelope.correlationId, undefined);
      assert.equal(envelope.payload?.correlationId, REQUEST_ID);
      assert.equal(envelope.payload?.mediaAssetId, asset.id);
      assert.equal(envelope.jobType, "media.inspect");
      const duplicate = await fetch(`${base}/projects/${project.id}/uploads/complete`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-actor": OWNER,
          "x-request-id": REQUEST_ID,
        },
        body: JSON.stringify({
          filename: "lecture.mp4",
          mimeType: "video/mp4",
          byteSize: body.byteLength,
          sha256: hash,
        }),
      });
      assert.equal(duplicate.status, 409);
      const stillOne = await pool.query("SELECT id FROM jobs WHERE idempotency_key = $1", [
        `media.inspect.${asset.id}`,
      ]);
      assert.equal(stillOne.rowCount, 1);

      const workerEntry = path.resolve(__dirname, "../../../workers/media-worker/dist/index.js");
      worker = spawn(process.execPath, [workerEntry], {
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          REDIS_URL: redisUrl(),
          MEDIA_INSPECT_QUEUE: queueName,
          WORKER_HEALTH_PORT: "0",
          S3_ENDPOINT: storageConfig().endpoint,
          S3_BUCKET: storageConfig().bucket,
          S3_ACCESS_KEY_ID: storageConfig().accessKeyId,
          S3_SECRET_ACCESS_KEY: storageConfig().secretAccessKey,
          S3_REGION: storageConfig().region,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      worker.stdout?.on("data", (chunk: Buffer) => {
        workerOut += chunk.toString("utf8");
      });
      worker.stderr?.on("data", (chunk: Buffer) => {
        workerErr += chunk.toString("utf8");
      });
      const startedAt = Date.now();
      let status = "Queued";
      while (Date.now() - startedAt < 20_000) {
        const row = await pool.query<{ status: string }>("SELECT status FROM jobs WHERE id = $1", [
          jobId,
        ]);
        status = row.rows[0]?.status ?? "";
        if (status === "Completed" || status === "Failed") {
          break;
        }
        await delay(100);
      }
      assert.equal(status, "Completed", `${workerErr}\n${workerOut}`);
      const score = await redis.zscore(`bull:${queueName}:completed`, jobId ?? "");
      if (score === null) {
        const keys = await redis.keys(`bull:${queueName}:*`);
        assert.fail(`BullMQ completed set is missing the job. keys=${keys.join(",")}`);
      }
      const attempts = await pool.query<{ status: string }>(
        "SELECT status FROM job_attempts WHERE job_id = $1",
        [jobId],
      );
      assert.equal(
        attempts.rows.some((row) => row.status === "Completed"),
        true,
      );
      const workerLines = jsonLines(workerOut);
      assert.deepEqual(
        workerLines.map((line) => line["message"]),
        ["job.started", "job.finished"],
        workerOut,
      );
      for (const line of workerLines) {
        assert.equal(line["correlationId"], REQUEST_ID);
        assert.equal(line["service"], "media-worker");
        assert.equal(line["subjectId"], asset.id);
      }
      const apiLines = jsonLines(lines.join(""));
      const accepted = apiLines.find((line) => line["message"] === "job.accepted");
      assert.ok(accepted);
      assert.equal(accepted["correlationId"], REQUEST_ID);
      assert.equal(accepted["service"], "api");
      assert.equal(accepted["subjectId"], asset.id);
    } finally {
      if (previousQueue === undefined) {
        delete process.env["MEDIA_INSPECT_QUEUE"];
      } else {
        process.env["MEDIA_INSPECT_QUEUE"] = previousQueue;
      }
      if (worker && worker.exitCode === null) {
        worker.kill("SIGTERM");
        await onceExit(worker);
      }
      if (storageKey.length > 0) {
        try {
          await objects.delete(storageKey);
        } catch {
          // The assertion already ran. Cleanup must not hide that result.
        }
      }
      await app.close();
      await queue.close();
      redis.disconnect();
      await pool.end();
    }
  },
);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function onceExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

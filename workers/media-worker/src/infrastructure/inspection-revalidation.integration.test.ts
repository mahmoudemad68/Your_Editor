import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { createUuidV7, instant, jobId, mediaAssetId, Job } from "@editagent/domain";
import {
  parseValidationPolicy,
  validationPolicySignature,
  MEDIA_INSPECT_TIMEOUT_MS,
} from "@editagent/shared";
import {
  BullMqJobQueue,
  PostgresJobRepository,
  publishMediaInspectJob,
  requestMediaRevalidation,
  runNextJob,
} from "@editagent/job-queue";
import { ChildProcessJobSupervisor } from "./child-job-supervisor.js";
import { createMediaS3Client } from "./s3-object-stream.js";
import { loadMediaWorkerConfig } from "./config.js";
import { PostgresMediaInspectionRepository } from "./postgres-media-inspection-repository.js";
import { isolatedRedisUrl, uniqueQueueSuffix } from "./test-redis.js";
import { assertValidatedMedia } from "../application/validate-media.js";
import { publishMediaDeriveJob } from "../application/publish-media-derive.js";

const root = path.resolve(__dirname, "../../../..");
const id = () => createUuidV7(Date.now(), randomBytes(10));
const now = () => instant(BigInt(Date.now()));

test(
  "US-127 production budgets, slow staging, terminal recovery and policy-aware concurrent revalidation",
  { timeout: 240000 },
  async () => {
    const base = {
      ...process.env,
      DATABASE_URL:
        process.env["DATABASE_URL"] ??
        "postgresql://editagent:editagent-dev-password@127.0.0.1:5432/editagent",
      REDIS_URL: process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379/0",
      S3_ENDPOINT: process.env["S3_ENDPOINT"] ?? "http://127.0.0.1:9000",
      S3_BUCKET: process.env["S3_BUCKET"] ?? "editagent",
      S3_ACCESS_KEY_ID: process.env["S3_ACCESS_KEY_ID"] ?? "editagent",
      S3_SECRET_ACCESS_KEY: process.env["S3_SECRET_ACCESS_KEY"] ?? "editagent-dev-secret",
      S3_REGION: process.env["S3_REGION"] ?? "us-east-1",
    };
    const config = loadMediaWorkerConfig(base),
      database = `us127_revalidate_${process.pid}`;
    const admin = new Pool({ connectionString: base.DATABASE_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    const url = new URL(base.DATABASE_URL);
    url.pathname = `/${database}`;
    const directory = await mkdtemp("/tmp/us127-revalidation-");
    const pool = new Pool({ connectionString: url.toString(), max: 1 });
    const queue = new BullMqJobQueue(isolatedRedisUrl(8, base.REDIS_URL));
    const jobs = new PostgresJobRepository(pool),
      repo = new PostgresMediaInspectionRepository(pool);
    const s3 = createMediaS3Client(config.objectStorage),
      keys = new Set<string>();
    const deps = {
      jobs,
      queue,
      supervisor: new ChildProcessJobSupervisor(),
      now,
      newAttemptId: id,
    };
    const queueName = `revalidate${uniqueQueueSuffix()}`;
    const handler = {
      modulePath: path.join(__dirname, "../handlers/media-jobs.js"),
      exportName: "handleMediaJob",
    };
    let mode: "slow" | "unavailable" | "healthy" = "slow",
      gets = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const upstream = new URL(base.S3_ENDPOINT);
    const proxy = createServer((req, res) => {
      const forward = () => {
        if (res.destroyed) return;
        const target = request(
          {
            hostname: upstream.hostname,
            port: upstream.port,
            path: req.url,
            method: req.method,
            headers: req.headers,
          },
          (response) => {
            res.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(res);
          },
        );
        res.on("close", () => target.destroy());
        target.on("error", () => {
          if (!res.destroyed) {
            res.writeHead(503);
            res.end();
          }
        });
        req.pipe(target);
      };
      if (req.method !== "GET") {
        forward();
        return;
      }
      gets++;
      if (mode === "unavailable") {
        res.writeHead(503);
        res.end();
        return;
      }
      if (mode === "slow") {
        const timer = setTimeout(() => {
          timers.delete(timer);
          forward();
        }, 40000);
        timers.add(timer);
        res.on("close", () => {
          clearTimeout(timer);
          timers.delete(timer);
        });
      } else forward();
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const address = proxy.address();
    assert.ok(address && typeof address !== "string");
    const runtime = {
      ...base,
      DATABASE_URL: url.toString(),
      PROBE_TMPDIR: directory,
      S3_ENDPOINT: `http://127.0.0.1:${address.port}`,
      MEDIA_VALIDATION_MAX_BITRATE: "100000000",
    };
    const saved = Object.fromEntries(Object.keys(runtime).map((k) => [k, process.env[k]]));
    Object.assign(process.env, runtime);
    try {
      for (const n of (await readdir(path.join(root, "apps/api/migrations")))
        .filter((n) => n.endsWith(".sql"))
        .sort())
        await pool.query(await readFile(path.join(root, "apps/api/migrations", n), "utf8"));
      const bytes = await readFile(
        path.join(root, "packages/media-core/fixtures/media/normal.mp4"),
      );
      async function store(content: Buffer) {
        const project = id(),
          asset = mediaAssetId(id());
        const hash = createHash("sha256").update(content).digest("hex"),
          key = `projects/${project}/media/sha256/${hash}`;
        await pool.query(
          "INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'revalidation',1,1)",
          [project],
        );
        keys.add(key);
        await s3.send(
          new PutObjectCommand({
            Bucket: config.objectStorage.bucket,
            Key: key,
            Body: content,
            ContentType: "video/mp4",
          }),
        );
        await pool.query(
          "INSERT INTO media_assets(id,project_id,kind,storage_key,display_filename,mime_type,byte_size,content_sha256,upload_state,created_at,updated_at) VALUES($1,$2,'video',$3,'valid.mp4','video/mp4',$4,$5,'uploaded',1,1)",
          [asset, project, key, content.length, hash],
        );
        return { asset, project };
      }
      async function execute(job: string) {
        const until = Date.now() + 120000;
        while (Date.now() < until) {
          await runNextJob(deps, queueName, handler);
          const stored = await jobs.findById(jobId(job));
          assert.ok(stored);
          if (["Completed", "Failed", "Cancelled"].includes(stored.status)) return stored;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error("Inspection failed to finish in test deadline.");
      }
      const first = await store(bytes),
        started = Date.now();
      const initial = await publishMediaInspectJob(deps, {
        jobId: id(),
        mediaAssetId: first.asset,
        correlationId: id(),
        queueName,
      });
      const completed = await execute(initial.jobId);
      assert.equal(completed.timeoutMs, MEDIA_INSPECT_TIMEOUT_MS);
      assert.equal(completed.status, "Completed");
      assert.equal(completed.attemptCount, 1);
      assert.ok(Date.now() - started >= 40000);
      const s1 = await repo.findById(first.asset);
      assert.ok(s1);
      assert.equal(s1.validation.status, "validated");
      const sig1 = validationPolicySignature(parseValidationPolicy(runtime));
      assert.equal(s1.validation.policySignature, sig1);
      // Automatic publication remains idempotent even with another correlation.
      const duplicate = await publishMediaInspectJob(deps, {
        jobId: id(),
        mediaAssetId: first.asset,
        correlationId: id(),
        queueName,
      });
      assert.equal(duplicate.jobId, completed.id);
      assert.equal(await runNextJob(deps, queueName, handler), "idle");
      console.log(
        "US127_SLOW_STAGING",
        JSON.stringify({
          delayMs: 40000,
          elapsedMs: Date.now() - started,
          timeoutMs: completed.timeoutMs,
          status: completed.status,
          attempts: completed.attemptCount,
        }),
      );
      mode = "healthy";
      process.env["MEDIA_VALIDATION_MAX_BITRATE"] = "110000000";
      const policy2 = parseValidationPolicy({
          ...runtime,
          MEDIA_VALIDATION_MAX_BITRATE: "110000000",
        }),
        sig2 = validationPolicySignature(policy2);
      assert.notEqual(sig1, sig2);
      assert.throws(() => assertValidatedMedia(s1, sig2, new AbortController().signal));
      const revalidation = {
        mediaAssetId: first.asset,
        previousJobId: completed.id,
        queueName,
        policy: policy2,
      };
      const concurrent = await Promise.all(
        Array.from({ length: 3 }, () =>
          requestMediaRevalidation(deps, { ...revalidation, jobId: id(), correlationId: id() }),
        ),
      );
      assert.equal(new Set(concurrent.map((j) => j.jobId)).size, 1);
      assert.notEqual(concurrent[0]!.jobId, completed.id);
      assert.equal((await execute(concurrent[0]!.jobId)).status, "Completed");
      const s2 = await repo.findById(first.asset);
      assert.ok(s2);
      assert.equal(s2.validation.policySignature, sig2);
      assert.ok(s2.validation.checkedAt! > s1.validation.checkedAt!);
      assertValidatedMedia(s2, sig2, new AbortController().signal);
      assert.equal((await jobs.findById(jobId(completed.id)))?.status, "Completed");
      assert.equal(await runNextJob(deps, queueName, handler), "idle");
      const derive = await publishMediaDeriveJob(deps, {
        jobId: id(),
        mediaAssetId: first.asset,
        projectId: first.project,
        correlationId: id(),
        queueName,
      });
      assert.equal((await execute(derive.jobId)).status, "Completed");
      const derived = await pool.query(
        "SELECT storage_key FROM derived_assets WHERE media_asset_id=$1",
        [first.asset],
      );
      assert.equal(derived.rowCount, 5);
      for (const row of derived.rows) keys.add(row.storage_key as string);
      assert.equal(
        (
          await s3.send(
            new ListObjectsV2Command({
              Bucket: config.objectStorage.bucket,
              Prefix: `projects/${first.project}/derived/`,
            }),
          )
        ).Contents?.length,
        5,
      );
      console.log(
        "US127_POLICY_REVALIDATION",
        JSON.stringify({
          sig1,
          sig2,
          oldJob: completed.id,
          newJob: concurrent[0]!.jobId,
          concurrentJobs: 1,
          checkedAtAdvanced: true,
          derive: "Completed",
          derivedRows: derived.rowCount,
        }),
      );

      // Real infrastructure failure exhausts bounded production attempts without
      // misclassifying content. Recovery invokes only the production queue service.
      const recovery = await store(bytes);
      mode = "unavailable";
      const failedIntent = await publishMediaInspectJob(deps, {
        jobId: id(),
        mediaAssetId: recovery.asset,
        correlationId: id(),
        queueName,
      });
      const failed = await execute(failedIntent.jobId);
      assert.equal(failed.status, "Failed");
      assert.equal(failed.attemptCount, 2);
      const pending = await repo.findById(recovery.asset);
      assert.ok(pending);
      assert.equal(pending.validation.status, "pending");
      assert.equal(pending.validation.rejectionCode, null);
      assert.throws(() => assertValidatedMedia(pending, sig2, new AbortController().signal));
      mode = "healthy";
      const retryInput = {
        mediaAssetId: recovery.asset,
        previousJobId: failed.id,
        queueName,
        policy: policy2,
      };
      const retries = await Promise.all(
        Array.from({ length: 2 }, () =>
          requestMediaRevalidation(deps, { ...retryInput, jobId: id(), correlationId: id() }),
        ),
      );
      assert.equal(retries[0]!.jobId, retries[1]!.jobId);
      const recovered = await execute(retries[0]!.jobId);
      assert.equal(recovered.status, "Completed");
      assert.notEqual(recovered.id, failed.id);
      assert.equal((await jobs.findById(jobId(failed.id)))?.status, "Failed");
      assert.equal((await jobs.listAttempts(jobId(failed.id))).length, 2);
      const valid = await repo.findById(recovery.asset);
      assert.ok(valid);
      assert.equal(valid.validation.status, "validated");
      const replay = await requestMediaRevalidation(deps, {
        ...retryInput,
        jobId: id(),
        correlationId: id(),
      });
      assert.equal(replay.jobId, recovered.id);
      assert.equal(await runNextJob(deps, queueName, handler), "idle");
      await assert.rejects(
        requestMediaRevalidation(deps, {
          ...retryInput,
          mediaAssetId: first.asset,
          jobId: id(),
          correlationId: id(),
        }),
      );
      console.log(
        "US127_TRANSIENT_RECOVERY",
        JSON.stringify({
          oldJob: failed.id,
          oldStatus: failed.status,
          attempts: failed.attemptCount,
          oldVerdict: pending.validation.status,
          newJob: recovered.id,
          newStatus: recovered.status,
          newVerdict: valid.validation.status,
          gets,
        }),
      );
      // Preserve and execute a genuinely queued pre-repair production intent.
      // Its historical 30s deadline is immutable; use the real supervisor and a
      // 40s object acquisition to reproduce both outer timeouts (not a fake error).
      const legacy = await store(bytes);
      const legacyId = jobId(id());
      await jobs.save(
        Job.create(legacyId, { kind: "media-asset", mediaAssetId: legacy.asset }, now(), {
          queueName,
          jobType: "media.inspect",
          idempotencyKey: `media.inspect.${legacy.asset}`,
          timeoutMs: 30000,
          maxAttempts: 2,
          payload: { mediaAssetId: legacy.asset, correlationId: id() },
        }),
      );
      mode = "slow";
      const historical = await publishMediaInspectJob(deps, {
        jobId: id(),
        mediaAssetId: legacy.asset,
        correlationId: id(),
        queueName,
      });
      assert.equal(historical.jobId, legacyId);
      const timedOut = await execute(historical.jobId);
      assert.equal(timedOut.status, "Failed");
      assert.equal(timedOut.failureReason, "timed out");
      assert.equal(timedOut.attemptCount, 2);
      const beforeRecovery = await repo.findById(legacy.asset);
      assert.ok(beforeRecovery);
      assert.equal(beforeRecovery.validation.status, "pending");
      assert.equal(beforeRecovery.validation.rejectionCode, null);
      const fresh = await requestMediaRevalidation(deps, {
        jobId: id(),
        mediaAssetId: legacy.asset,
        previousJobId: timedOut.id,
        correlationId: id(),
        queueName,
        policy: policy2,
      });
      const recoveredTimeout = await execute(fresh.jobId);
      assert.equal(recoveredTimeout.status, "Completed");
      assert.equal(recoveredTimeout.timeoutMs, MEDIA_INSPECT_TIMEOUT_MS);
      assert.equal(recoveredTimeout.attemptCount, 1);
      assert.equal((await repo.findById(legacy.asset))?.validation.status, "validated");
      assert.equal((await jobs.findById(legacyId))?.status, "Failed");
      assert.equal((await jobs.listAttempts(legacyId)).length, 2);
      console.log(
        "US127_GENUINE_TIMEOUT_RECOVERY",
        JSON.stringify({
          oldTimeoutMs: timedOut.timeoutMs,
          oldJob: timedOut.id,
          oldStatus: timedOut.status,
          oldAttempts: timedOut.attemptCount,
          oldRejection: beforeRecovery.validation.rejectionCode,
          newTimeoutMs: recoveredTimeout.timeoutMs,
          newJob: recoveredTimeout.id,
          newStatus: recoveredTimeout.status,
          newAttempts: recoveredTimeout.attemptCount,
          delayedStagingMs: 40000,
        }),
      );
      assert.deepEqual(await readdir(directory), []);
    } finally {
      for (const timer of timers) clearTimeout(timer);
      proxy.closeAllConnections();
      await new Promise<void>((r) => proxy.close(() => r()));
      for (const key of keys)
        await s3.send(new DeleteObjectCommand({ Bucket: config.objectStorage.bucket, Key: key }));
      s3.destroy();
      await queue.close();
      await pool.end();
      await rm(directory, { recursive: true, force: true });
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      const clean = new Pool({ connectionString: base.DATABASE_URL });
      await clean.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await clean.end();
    }
  },
);

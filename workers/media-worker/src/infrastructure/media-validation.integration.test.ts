import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { createUuidV7, instant, mediaAssetId } from "@editagent/domain";
import {
  BullMqJobQueue,
  PostgresJobRepository,
  enqueueJob,
  runNextJob,
  mediaInspectQueueName,
} from "@editagent/job-queue";
import { ChildProcessJobSupervisor } from "./child-job-supervisor.js";
import { isolatedRedisUrl, uniqueQueueSuffix } from "./test-redis.js";
import { createMediaS3Client } from "./s3-object-stream.js";
import { loadMediaWorkerConfig } from "./config.js";
import { PostgresMediaInspectionRepository } from "./postgres-media-inspection-repository.js";
import { publishMediaDeriveJob } from "../application/publish-media-derive.js";
import { assertValidatedMedia } from "../application/validate-media.js";
import { validationPolicySignature } from "../application/validation-policy.js";
const root = path.resolve(__dirname, "../../../..");
const id = () => createUuidV7(Date.now(), randomBytes(10)),
  now = () => instant(BigInt(Date.now()));
const adminUrl =
  process.env["DATABASE_URL"] ??
  "postgresql://editagent:editagent-dev-password@127.0.0.1:5432/editagent";
const env = {
  ...process.env,
  DATABASE_URL: adminUrl,
  REDIS_URL: process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379/0",
  S3_ENDPOINT: process.env["S3_ENDPOINT"] ?? "http://127.0.0.1:9000",
  S3_BUCKET: process.env["S3_BUCKET"] ?? "editagent",
  S3_ACCESS_KEY_ID: process.env["S3_ACCESS_KEY_ID"] ?? "editagent",
  S3_SECRET_ACCESS_KEY: process.env["S3_SECRET_ACCESS_KEY"] ?? "editagent-dev-secret",
  S3_REGION: process.env["S3_REGION"] ?? "us-east-1",
};

test(
  "US-127 real object -> media.inspect -> durable verdict -> enforced media.derive gate",
  { timeout: 120000 },
  async () => {
    const database = `editagent_us127_${process.pid}`;
    const admin = new Pool({ connectionString: adminUrl });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    const url = new URL(adminUrl);
    url.pathname = `/${database}`;
    const directory = await mkdtemp(path.join(tmpdir(), "us127-worker-"));
    const runtime = { ...env, DATABASE_URL: url.toString(), PROBE_TMPDIR: directory };
    const saved = Object.fromEntries(Object.keys(runtime).map((k) => [k, process.env[k]]));
    Object.assign(process.env, runtime);
    const config = loadMediaWorkerConfig(runtime),
      pool = new Pool({ connectionString: url.toString(), max: 1 }),
      queue = new BullMqJobQueue(isolatedRedisUrl(8, env.REDIS_URL));
    const s3 = createMediaS3Client(config.objectStorage),
      keys = new Set<string>(),
      project = id(),
      repo = new PostgresMediaInspectionRepository(pool);
    const deps = {
      jobs: new PostgresJobRepository(pool),
      queue,
      supervisor: new ChildProcessJobSupervisor(),
      now,
      newAttemptId: id,
    };
    const queueName = `us127${uniqueQueueSuffix()}`,
      handler = {
        modulePath: path.join(__dirname, "../handlers/media-jobs.js"),
        exportName: "handleMediaJob",
      };
    let requests = 0;
    const canary = createServer((_req, res) => {
      requests++;
      res.end("unexpected");
    });
    await new Promise<void>((r) => canary.listen(0, "127.0.0.1", r));
    const addr = canary.address();
    assert.ok(addr && typeof addr !== "string");
    try {
      for (const name of (await readdir(path.join(root, "apps/api/migrations")))
        .filter((n) => n.endsWith(".sql"))
        .sort())
        await pool.query(await readFile(path.join(root, "apps/api/migrations", name), "utf8"));
      await pool.query(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'US127',1,1)",
        [project],
      );
      const file = path.join(directory, "valid.mp4");
      const made = spawnSync(
        "ffmpeg",
        [
          "-hide_banner",
          "-v",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=160x120:rate=30:duration=1",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=1",
          "-c:v",
          "libx264",
          "-threads",
          "2",
          "-c:a",
          "aac",
          file,
        ],
        { timeout: 30000, encoding: "utf8" },
      );
      assert.equal(made.status, 0, made.stderr);
      const validBytes = await readFile(file);
      async function store(bytes: Buffer, name: string) {
        const asset = mediaAssetId(id()),
          hash = createHash("sha256").update(bytes).digest("hex"),
          key = `projects/${project}/media/sha256/${hash}`;
        keys.add(key);
        await s3.send(
          new PutObjectCommand({
            Bucket: config.objectStorage.bucket,
            Key: key,
            Body: bytes,
            ContentType: "video/mp4",
          }),
        );
        await pool.query(
          "INSERT INTO media_assets(id,project_id,kind,storage_key,display_filename,mime_type,byte_size,content_sha256,upload_state,created_at,updated_at) VALUES($1,$2,'video',$3,$4,'video/mp4',$5,$6,'uploaded',$7,$7)",
          [asset, project, key, name, Math.max(1, bytes.length), hash, now().toString()],
        );
        return asset;
      }
      async function inspect(asset: ReturnType<typeof mediaAssetId>, attempt: string) {
        const job = await enqueueJob(deps, {
          id: id(),
          queueName: mediaInspectQueueName(queueName),
          jobType: "media.inspect",
          idempotencyKey: `media.inspect.${asset}.${attempt}`,
          subject: { kind: "media-asset", mediaAssetId: asset },
          payload: { mediaAssetId: asset, correlationId: id() },
          timeoutMs: 45000,
          maxAttempts: 3,
          backoffBaseMs: 1000,
        });
        assert.equal(await runNextJob(deps, queueName, handler), "done");
        return (await pool.query("SELECT status FROM jobs WHERE id=$1", [job.jobId])).rows[0] as {
          status: string;
        };
      }
      async function encoded(name: string, args: string[]): Promise<Buffer> {
        const output = path.join(directory, name);
        const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...args, output], {
          encoding: "utf8",
          timeout: 30000,
        });
        assert.equal(result.status, 0, result.stderr);
        return readFile(output);
      }
      const huge = await encoded("huge.mp4", [
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=8192x16:rate=1:duration=1",
        "-c:v",
        "libx264",
        "-threads",
        "2",
      ]);
      const unsupportedVideo = await encoded("unsupported-video.mp4", [
        "-i",
        file,
        "-c:v",
        "mpeg4",
        "-c:a",
        "copy",
      ]);
      const unsupportedAudio = await encoded("unsupported-audio.mp4", [
        "-i",
        file,
        "-c:v",
        "copy",
        "-c:a",
        "libmp3lame",
      ]);
      const excessive = await encoded("streams.mp4", [
        "-i",
        file,
        ...Array.from({ length: 9 }, () => ["-map", "0:v:0"]).flat(),
        "-c",
        "copy",
      ]);
      const long = await encoded("long.mp4", [
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=128x96:rate=1:duration=2",
        "-vf",
        "setpts=PTS*1801",
        "-fps_mode",
        "vfr",
        "-c:v",
        "libx264",
        "-threads",
        "2",
      ]);
      for (const [name, bytes, code] of [
        ["valid.disguised", validBytes, null],
        ["empty.mp4", Buffer.alloc(0), "empty_media"],
        ["truncated.mp4", validBytes.subarray(0, validBytes.length - 64), "corrupt_media"],
        ["fake.mp4", Buffer.from("not a video"), "invalid_signature"],
        ["huge.mp4", huge, "resolution_limit_exceeded"],
        ["unsupported-video.mp4", unsupportedVideo, "unsupported_codec"],
        ["unsupported-audio.mp4", unsupportedAudio, "unsupported_codec"],
        ["streams.mp4", excessive, "stream_count_limit_exceeded"],
        ["long.mp4", long, "duration_limit_exceeded"],
        ["avi.mp4", Buffer.from("RIFFxxxxxxxxAVI "), "unsupported_container"],
        [
          "concat.mp4",
          Buffer.from("ffconcat version 1.0\nfile '/etc/passwd'\n"),
          "unsafe_external_reference",
        ],
        [
          "remote.mp4",
          Buffer.from(`#EXTM3U\nhttp://127.0.0.1:${addr.port}/internal\n`),
          "unsafe_external_reference",
        ],
      ] as [string, Buffer, string | null][]) {
        const asset = await store(bytes, name);
        const job = await inspect(asset, "first");
        assert.equal(job.status, code === null ? "Completed" : "Failed");
        const verdict = await repo.findById(asset);
        assert.ok(verdict);
        assert.equal(verdict.validation.status, code === null ? "validated" : "rejected");
        assert.equal(verdict.validation.rejectionCode, code);
        const replay = await inspect(asset, "replay");
        assert.equal(replay.status, job.status);
        const restored = await repo.findById(asset);
        assert.ok(restored);
        assert.equal(restored.validation.rejectionCode, code);
        if (code === null)
          assertValidatedMedia(
            restored,
            validationPolicySignature(config.validationPolicy),
            new AbortController().signal,
          );
        else
          assert.throws(() =>
            assertValidatedMedia(
              restored,
              validationPolicySignature(config.validationPolicy),
              new AbortController().signal,
            ),
          );
        const derive = await publishMediaDeriveJob(deps, {
          jobId: id(),
          mediaAssetId: asset,
          projectId: project,
          correlationId: id(),
          queueName,
        });
        assert.equal(await runNextJob(deps, queueName, handler), "done");
        const deriveState = await pool.query("SELECT status FROM jobs WHERE id=$1", [derive.jobId]);
        assert.equal(deriveState.rows[0]?.status, code === null ? "Completed" : "Failed");
        const rows = await pool.query(
          "SELECT storage_key FROM derived_assets WHERE media_asset_id=$1",
          [asset],
        );
        assert.equal(rows.rowCount, code === null ? 5 : 0);
        for (const row of rows.rows) keys.add(row.storage_key as string);
        // Rejected permanent jobs produce no scheduled retry after terminal failure.
        assert.equal(await runNextJob(deps, queueName, handler), "idle");
        console.log(
          "US127_DURABLE",
          JSON.stringify({
            name,
            validation: restored.validation.status,
            code,
            inspectJob: job.status,
            deriveJob: deriveState.rows[0]?.status,
            derivedRows: rows.rowCount,
          }),
        );
      }
      assert.equal(requests, 0);
      console.log("US127_REAL_WORKER_CANARY_REQUESTS", requests);
      assert.deepEqual(
        (await readdir(directory)).filter((n) => n.startsWith("editagent-probe-")),
        [],
      );
      assert.equal(
        (
          await s3.send(
            new ListObjectsV2Command({
              Bucket: config.objectStorage.bucket,
              Prefix: `projects/${project}/derived/`,
            }),
          )
        ).Contents?.length,
        5,
      );
    } finally {
      await new Promise<void>((r, j) => canary.close((e) => (e ? j(e) : r())));
      for (const key of keys)
        await s3.send(new DeleteObjectCommand({ Bucket: config.objectStorage.bucket, Key: key }));
      s3.destroy();
      await queue.close();
      await pool.end();
      await rm(directory, { recursive: true, force: true });
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      const clean = new Pool({ connectionString: adminUrl });
      await clean.query(`DROP DATABASE ${database} WITH(FORCE)`);
      await clean.end();
    }
  },
);

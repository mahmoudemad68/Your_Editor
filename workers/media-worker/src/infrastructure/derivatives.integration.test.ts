import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createUuidV7, instant, mediaAssetId, MediaAsset, DerivedAsset } from "@editagent/domain";
import { FFprobeMediaProbe } from "@editagent/media-core";
import { Pool } from "pg";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { deriveMediaAsset, type DerivationDependencies } from "../application/derive-media.js";
import { derivativePlans, parameterSignature, PROXY_FPS } from "../application/derivative-plan.js";
import {
  FFmpegDerivativeProcessor,
  buildDerivativeArgs,
  runControlledProcess,
} from "./ffmpeg-derivative-processor.js";
import { PostgresDerivedAssets } from "./postgres-derived-assets.js";
import { S3DerivedObjects } from "./s3-derived-objects.js";
import { createMediaS3Client, S3ObjectByteSource } from "./s3-object-stream.js";
import { FileObjectStager } from "./object-stager.js";
import { loadMediaWorkerConfig } from "./config.js";
import { BullMqJobQueue, PostgresJobRepository, runNextJob } from "@editagent/job-queue";
import { publishMediaDeriveJob } from "../application/publish-media-derive.js";
import { ChildProcessJobSupervisor } from "./child-job-supervisor.js";
import { isolatedRedisUrl, uniqueQueueSuffix } from "./test-redis.js";
import { PermanentJobError } from "../application/job-errors.js";
import { validateDerivationEnvelope } from "../handlers/media-jobs.js";
import { type JobEnvelope } from "@editagent/domain";

const root = path.resolve(__dirname, "../../../..");
const newId = () => createUuidV7(Date.now(), randomBytes(10));
const now = () => instant(BigInt(Date.now()));
const signal = () => new AbortController().signal;
const adminUrl =
  process.env["DATABASE_URL"] ??
  "postgresql://editagent:editagent-dev-password@127.0.0.1:5432/editagent";
const database = `editagent_us128_derivatives_${process.pid}`;
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
function ffmpeg(args: string[]): void {
  const result = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-threads", "2", ...args],
    { timeout: 30000, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
}
function probe(file: string): Record<string, unknown> {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-show_frames",
      "-show_entries",
      "format=duration:stream=codec_name,width,height,pix_fmt,avg_frame_rate,sample_rate,channels:frame=key_frame,best_effort_timestamp_time",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test(
  "US-128 real PostgreSQL, FFmpeg and private SeaweedFS derivation",
  { timeout: 120000 },
  async (t) => {
    const admin = new Pool({ connectionString: adminUrl });
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    const db = new URL(adminUrl);
    db.pathname = `/${database}`;
    const pool = new Pool({ connectionString: db.toString(), max: 1 });
    const config = loadMediaWorkerConfig(env);
    const s3 = createMediaS3Client(config.objectStorage);
    const bucket = config.objectStorage.bucket;
    const directory = await mkdtemp(path.join(tmpdir(), "us128-test-"));
    const keys = new Set<string>();
    const project = newId();
    const otherProject = newId();
    const mediaRepo = new PostgresDerivedAssets(pool);
    const objects = new S3DerivedObjects(s3, bucket);
    let generationCount = 0;
    let stagingCount = 0;
    const realProcessor = new FFmpegDerivativeProcessor(config.ffmpegPath, config.ffprobePath);
    const deps: DerivationDependencies = {
      repository: mediaRepo,
      objects,
      staging: {
        stage: async (key, abort) => {
          stagingCount++;
          return new FileObjectStager({
            source: new S3ObjectByteSource(s3, bucket),
            rootDir: directory,
          }).stage(key, abort);
        },
      },
      processor: {
        prepare: async (source, input, abort) => {
          const p = await realProcessor.prepare(source, input, abort);
          return {
            release: () => p.release(),
            generate: async (plan, a) => {
              generationCount++;
              return p.generate(plan, a);
            },
          };
        },
      },
      gate: { assertAllowed: async (_source, a) => a.throwIfAborted() },
      now,
      newId,
    };
    async function persist(file: string, displayFilename = "normal.mp4") {
      const bytes = await readFile(file);
      const sha = createHash("sha256").update(bytes).digest("hex");
      const id = mediaAssetId(newId());
      const storageKey = `projects/${project}/media/sha256/${sha}`;
      keys.add(storageKey);
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: storageKey,
          ContentType: "video/mp4",
          Body: createReadStream(file),
          ContentLength: bytes.length,
        }),
      );
      await pool.query(
        `INSERT INTO media_assets (id,project_id,kind,storage_key,display_filename,mime_type,byte_size,content_sha256,upload_state,created_at,updated_at)
      VALUES ($1,$2,'video',$3,$4,'video/mp4',$5,$6,'uploaded',$7,$7)`,
        [id, project, storageKey, displayFilename, bytes.length, sha, now().toString()],
      );
      const raw = await mediaRepo.loadSource(id, project);
      assert.ok(raw);
      const inspected = raw.recordInspection(
        await new FFprobeMediaProbe().inspect({ filePath: file }),
        now(),
      );
      // Use the existing worker inspection repository, through its public adapter.
      const { PostgresMediaInspectionRepository } =
        await import("./postgres-media-inspection-repository.js");
      await new PostgresMediaInspectionRepository(pool).saveInspection(inspected, 0n);
      for (const p of derivativePlans(inspected)) keys.add(p.storageKey);
      return inspected;
    }
    try {
      for (const name of (await readdir(path.join(root, "apps/api/migrations")))
        .filter((n) => n.endsWith(".sql"))
        .sort())
        await pool.query(await readFile(path.join(root, "apps/api/migrations", name), "utf8"));
      for (const id of [project, otherProject])
        await pool.query(
          "INSERT INTO projects (id,name,created_at,updated_at) VALUES ($1,'US128',1,1)",
          [id],
        );
      const sourceFile = path.join(directory, "source.mp4");
      ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=960x720:rate=30:duration=2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=2",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ac",
        "2",
        "-shortest",
        sourceFile,
      ]);
      const source = await persist(sourceFile, "innocent;touch PWNED.mp4");
      let first: readonly DerivedAsset[] = [];
      let firstObjectCount = 0;
      await t.test(
        "five real outputs have one-frame duration parity, formats, faststart, GOP and private metadata",
        async () => {
          first = await deriveMediaAsset(source.id, project, signal(), deps);
          assert.equal(first.length, 5);
          assert.equal(generationCount, 5);
          assert.equal(stagingCount, 1);
          const measurements: Record<string, unknown> = {
            sourceDurationUs: source.duration?.toString(),
            oneFrameUs: 1_000_000 / PROXY_FPS,
            ids: first.map((a) => a.id),
            keys: first.map((a) => a.artifact?.storageKey),
          };
          for (const a of first) {
            const artifact = a.artifact!;
            const p = derivativePlans(source).find(
              (p) => p.signature === artifact.parameterSignature,
            )!;
            const head = await s3.send(
              new HeadObjectCommand({ Bucket: bucket, Key: artifact.storageKey }),
            );
            assert.equal(head.ContentType, p.mimeType);
            assert.equal(String(head.ContentLength), artifact.byteSize);
            const fetched = await s3.send(
              new GetObjectCommand({ Bucket: bucket, Key: artifact.storageKey }),
            );
            const bytes = Buffer.from(await fetched.Body!.transformToByteArray()); // small synthetic test output only
            assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
            const file = path.join(directory, `${p.variant}-independent`);
            await import("node:fs/promises").then((fs) => fs.writeFile(file, bytes));
            const actual = probe(file);
            const stream = (actual["streams"] as Record<string, unknown>[])[0]!;
            const format = actual["format"] as Record<string, unknown>;
            if (["proxy", "asr", "mix"].includes(p.variant)) {
              const durationUs = Math.round(Number(format["duration"]) * 1e6);
              const delta = Math.abs(durationUs - Number(source.duration));
              assert.ok(delta <= 1e6 / 30, `${p.variant} delta ${delta}`);
              measurements[p.variant] = {
                durationUs,
                deltaUs: delta,
                bytes: artifact.byteSize,
                sha256: artifact.sha256,
              };
            }
            if (p.variant === "proxy") {
              assert.equal(stream["width"], 720);
              assert.equal(stream["height"], 540);
              assert.equal(stream["codec_name"], "h264");
              assert.equal(stream["pix_fmt"], "yuv420p");
              assert.equal(stream["avg_frame_rate"], "30/1");
              Object.assign(measurements["proxy"] as object, {
                width: stream["width"],
                height: stream["height"],
                codec: stream["codec_name"],
                pixelFormat: stream["pix_fmt"],
                fps: stream["avg_frame_rate"],
              });
              assert.ok(bytes.indexOf(Buffer.from("moov")) < bytes.indexOf(Buffer.from("mdat")));
              const frames = actual["frames"] as Record<string, unknown>[];
              for (let i = 1; i < frames.length; i++)
                assert.ok(
                  Math.abs(
                    Number(frames[i]!["best_effort_timestamp_time"]) -
                      Number(frames[i - 1]!["best_effort_timestamp_time"]) -
                      1 / 30,
                  ) < 0.000002,
                  "CFR timestamp spacing",
                );
              const keyframes = (actual["frames"] as Record<string, unknown>[])
                .filter((f) => f["key_frame"] === 1)
                .map((f) => Number(f["best_effort_timestamp_time"]));
              assert.ok(keyframes.length >= 2);
              assert.ok(keyframes[1]! - keyframes[0]! <= 1.001);
            }
            if (p.variant === "asr") {
              assert.equal(stream["codec_name"], "pcm_s16le");
              assert.equal(stream["sample_rate"], "16000");
              assert.equal(stream["channels"], 1);
            }
            if (p.variant === "mix") {
              assert.equal(stream["codec_name"], "pcm_f32le");
              assert.equal(stream["sample_rate"], "48000");
              assert.equal(stream["channels"], 2);
            }
            if (p.variant === "poster") {
              assert.equal(stream["width"], 320);
              assert.equal(stream["height"], 180);
            }
            if (p.variant === "sprite") {
              assert.equal(stream["width"], 160);
              assert.equal(stream["height"], 90);
            }
            if (p.variant === "poster" || p.variant === "sprite")
              measurements[p.variant] = {
                bytes: artifact.byteSize,
                sha256: artifact.sha256,
                width: stream["width"],
                height: stream["height"],
                parameters: p.parameters,
              };
            const anonymous = await fetch(
              `${config.objectStorage.endpoint}/${bucket}/${artifact.storageKey}`,
            );
            assert.equal(anonymous.status, 403);
          }
          firstObjectCount =
            (
              await s3.send(
                new ListObjectsV2Command({
                  Bucket: bucket,
                  Prefix: `projects/${project}/derived/${source.id}/`,
                }),
              )
            ).Contents?.length ?? 0;
          assert.equal(firstObjectCount, 5);
          console.log("US128_AC1_REAL_MEASUREMENTS", JSON.stringify(measurements));
          assert.equal(
            (await readdir(directory)).some((name) => name === "PWNED"),
            false,
          );
        },
      );
      await t.test(
        "exact second run reuses IDs/keys without FFmpeg, staging or growing rows/objects",
        async () => {
          const second = await deriveMediaAsset(source.id, project, signal(), deps);
          assert.deepEqual(
            second.map((a) => a.toSnapshot()),
            first.map((a) => a.toSnapshot()),
          );
          assert.equal(generationCount, 5);
          assert.equal(stagingCount, 1);
          assert.equal((await mediaRepo.listByMediaAsset(source.id, project)).length, 5);
          const secondObjectCount =
            (
              await s3.send(
                new ListObjectsV2Command({
                  Bucket: bucket,
                  Prefix: `projects/${project}/derived/${source.id}/`,
                }),
              )
            ).Contents?.length ?? 0;
          assert.equal(secondObjectCount, firstObjectCount);
          console.log(
            "US128_AC2_REAL_REUSE",
            JSON.stringify({
              firstIds: first.map((a) => a.id),
              secondIds: second.map((a) => a.id),
              firstKeys: first.map((a) => a.artifact?.storageKey),
              secondKeys: second.map((a) => a.artifact?.storageKey),
              firstObjectCount,
              secondObjectCount,
              ffmpegFirst: 5,
              ffmpegSecond: 0,
              duplicateRows: false,
              duplicateObjects: false,
            }),
          );
        },
      );
      await t.test(
        "F-1 fixed sprite coexists with immutable buggy output and preserves all unrelated artifacts",
        async () => {
          const file = path.join(directory, "legacy-policy-source.mp4");
          ffmpeg([
            "-i",
            sourceFile,
            "-c",
            "copy",
            "-metadata",
            "comment=legacy-policy-fixture",
            file,
          ]);
          const asset = await persist(file);
          const plans = derivativePlans(asset);
          const sprite = plans.find((p) => p.variant === "sprite")!;
          const legacyParameters = { ...sprite.parameters };
          delete legacyParameters["samplingFps"];
          delete legacyParameters["frameSelection"];
          legacyParameters["sampling"] = "even-midpoints-maximum-20-five-seconds";
          const legacySignature = parameterSignature(legacyParameters);
          const legacy = {
            ...sprite,
            signature: legacySignature,
            parameters: legacyParameters,
            storageKey: sprite.storageKey.replace(sprite.signature, legacySignature),
          };
          keys.add(legacy.storageKey);
          assert.notEqual(legacy.signature, sprite.signature);
          const prepared = await realProcessor.prepare(asset, file, signal());
          const oldRows: DerivedAsset[] = [];
          try {
            for (const plan of plans) {
              const oldPlan = plan.variant === "sprite" ? legacy : plan;
              let output;
              if (plan.variant === "sprite") {
                const legacyFile = path.join(directory, "old-buggy-sprite.jpg");
                const args = [...buildDerivativeArgs(file, legacyFile, legacy)];
                const count = (legacyParameters["timestampsUs"] as number[]).length;
                const seconds = Number(asset.duration) / 1_000_000;
                args[args.indexOf("-vf") + 1] =
                  `tpad=stop_mode=clone:stop_duration=5,fps=${count}/${seconds}:start_time=${seconds / (2 * count)}:round=near,scale=w='max(2,trunc(iw*sar/2)*2)':h=ih,setsar=1,scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,tile=${legacyParameters["columns"]}x${legacyParameters["rows"]}:nb_frames=${count}`;
                await runControlledProcess(config.ffmpegPath, args, signal(), 30000);
                output = {
                  filePath: legacyFile,
                  metadata: { variant: "sprite", parameters: legacyParameters },
                };
              } else output = await prepared.generate(plan, signal());
              const artifact = await objects.put(asset, oldPlan, output, signal());
              oldRows.push(
                await mediaRepo.save(
                  new DerivedAsset(newId(), asset.id, oldPlan.kind, now(), undefined, artifact),
                ),
              );
            }
          } finally {
            await prepared.release();
          }
          const oldSprite = oldRows.find(
            (row) => row.artifact!.parameterSignature === legacySignature,
          )!;
          const oldSnapshot = oldSprite.toSnapshot();
          const before = generationCount;
          const fixed = await deriveMediaAsset(asset.id, project, signal(), deps);
          assert.equal(generationCount - before, 1, "only the fixed sprite needs generation");
          for (const old of oldRows.filter((row) => row !== oldSprite))
            assert.deepEqual(
              fixed.find((row) => row.id === old.id)!.toSnapshot(),
              old.toSnapshot(),
            );
          const fixedSprite = fixed.find((row) => row.artifact!.metadata["variant"] === "sprite")!;
          assert.notEqual(fixedSprite.id, oldSprite.id);
          assert.notEqual(fixedSprite.artifact!.sha256, oldSprite.artifact!.sha256);
          assert.deepEqual(
            (await mediaRepo.findBySignature(asset.id, "thumbnail", legacySignature))!.toSnapshot(),
            oldSnapshot,
          );
          assert.deepEqual(await objects.find(asset, legacy, signal()), oldSprite.artifact);
          const second = await deriveMediaAsset(asset.id, project, signal(), deps);
          assert.deepEqual(
            second.map((row) => row.toSnapshot()),
            fixed.map((row) => row.toSnapshot()),
          );
          assert.equal(generationCount - before, 1, "zero additional FFmpeg runs on fixed rerun");
          assert.equal(
            (await mediaRepo.listByMediaAsset(asset.id, project)).length,
            6,
            "five fixed results plus one historical immutable sprite",
          );
          const count = (
            await s3.send(
              new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: `projects/${project}/derived/${asset.id}/`,
              }),
            )
          ).Contents!.length;
          assert.equal(count, 6);
          console.log(
            "SPRITE_POLICY_MIGRATION",
            JSON.stringify({
              oldSignature: legacySignature,
              fixedSignature: sprite.signature,
              oldStorageKey: legacy.storageKey,
              fixedStorageKey: sprite.storageKey,
              firstFixedGenerations: 1,
              secondFixedGenerations: 0,
              preservedOtherIds: oldRows.filter((row) => row !== oldSprite).map((row) => row.id),
              historicalSpriteUnchanged: true,
              totalObjects: count,
              totalRows: 6,
            }),
          );
        },
      );
      await t.test(
        "recovery rejects object-size descriptor conflicts and changed staged source identity",
        async () => {
          const plan = derivativePlans(source)[0]!;
          const head = await s3.send(
            new HeadObjectCommand({ Bucket: bucket, Key: plan.storageKey }),
          );
          const bytes = await readFile(path.join(directory, "proxy-independent"));
          try {
            await s3.send(
              new PutObjectCommand({
                Bucket: bucket,
                Key: plan.storageKey,
                ContentType: plan.mimeType,
                Body: bytes,
                Metadata: { ...head.Metadata, "byte-size": String(bytes.length + 1) },
              }),
            );
            await assert.rejects(
              deriveMediaAsset(source.id, project, signal(), deps),
              PermanentJobError,
            );
          } finally {
            await s3.send(
              new PutObjectCommand({
                Bucket: bucket,
                Key: plan.storageKey,
                ContentType: plan.mimeType,
                Body: bytes,
                Metadata: head.Metadata!,
              }),
            );
          }
          // A broken source stager/provider cannot generate bytes under the declared identity.
          const altered: DerivationDependencies = {
            ...deps,
            objects: { find: async () => null, put: objects.put.bind(objects) },
            staging: {
              stage: async () => ({
                filePath: sourceFile,
                contentSha256: "ff".repeat(32),
                release: async () => {},
              }),
            },
          };
          const before = generationCount;
          await assert.rejects(
            deriveMediaAsset(source.id, project, signal(), altered),
            /source content identity changed/,
          );
          assert.equal(generationCount, before);
          assert.equal((await mediaRepo.listByMediaAsset(source.id, project)).length, 5);
        },
      );
      await t.test(
        "object stored/DB save crash recovers without regenerating; missing object repairs same row",
        async () => {
          await pool.query("DELETE FROM derived_assets WHERE media_asset_id=$1", [source.id]);
          const proxyPlan = derivativePlans(source).find((p) => p.variant === "proxy")!;
          await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: proxyPlan.storageKey }));
          const before = generationCount;
          let crashed = false;
          const crashing: DerivationDependencies = {
            ...deps,
            repository: {
              ...mediaRepo,
              loadSource: mediaRepo.loadSource.bind(mediaRepo),
              findBySignature: mediaRepo.findBySignature.bind(mediaRepo),
              listByMediaAsset: mediaRepo.listByMediaAsset.bind(mediaRepo),
              save: mediaRepo.save.bind(mediaRepo),
              withSourceLock: (id, sig, work) =>
                mediaRepo.withSourceLock(id, sig, (store) =>
                  work({
                    ...store,
                    loadSource: store.loadSource.bind(store),
                    findBySignature: store.findBySignature.bind(store),
                    listByMediaAsset: store.listByMediaAsset.bind(store),
                    save: async (asset) => {
                      if (!crashed) {
                        crashed = true;
                        throw new Error("DB save crash");
                      }
                      return store.save(asset);
                    },
                  }),
                ),
            },
          };
          await assert.rejects(
            deriveMediaAsset(source.id, project, signal(), crashing),
            /DB save crash/,
          );
          assert.equal((await mediaRepo.listByMediaAsset(source.id, project)).length, 0);
          first = await deriveMediaAsset(source.id, project, signal(), deps);
          assert.equal(generationCount, before + 1);
          const proxy = first.find((a) => a.kind === "proxy")!;
          await s3.send(
            new DeleteObjectCommand({ Bucket: bucket, Key: proxy.artifact!.storageKey }),
          );
          const repaired = await deriveMediaAsset(source.id, project, signal(), deps);
          assert.deepEqual(
            repaired.map((a) => a.id),
            first.map((a) => a.id),
          );
          assert.equal(generationCount, before + 2);
        },
      );
      await t.test(
        "partial generation/transient storage failure resumes; concurrent max=1 pool jobs serialize",
        async () => {
          for (const a of first)
            await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: a.artifact!.storageKey }));
          await pool.query("DELETE FROM derived_assets WHERE media_asset_id=$1", [source.id]);
          let failed = false;
          const failing = {
            ...deps,
            objects: {
              find: objects.find.bind(objects),
              put: async (
                s: MediaAsset,
                p: ReturnType<typeof derivativePlans>[number],
                o: Parameters<S3DerivedObjects["put"]>[2],
                a: AbortSignal,
              ) => {
                if (p.variant === "asr" && !failed) {
                  failed = true;
                  throw new Error("Transient storage");
                }
                return objects.put(s, p, o, a);
              },
            },
          };
          await assert.rejects(
            deriveMediaAsset(source.id, project, signal(), failing),
            /Transient storage/,
          );
          assert.equal((await mediaRepo.listByMediaAsset(source.id, project)).length, 1);
          const before = generationCount;
          const otherPool = new Pool({ connectionString: db.toString(), max: 1 });
          let one: readonly DerivedAsset[];
          let two: readonly DerivedAsset[];
          try {
            [one, two] = await Promise.all([
              deriveMediaAsset(source.id, project, signal(), deps),
              deriveMediaAsset(source.id, project, signal(), {
                ...deps,
                repository: new PostgresDerivedAssets(otherPool),
              }),
            ]);
          } finally {
            await otherPool.end();
          }
          assert.deepEqual(
            one.map((a) => a.id),
            two.map((a) => a.id),
          );
          assert.equal(generationCount, before + 4);
          assert.equal((await mediaRepo.listByMediaAsset(source.id, project)).length, 5);
          first = one;
        },
      );
      await t.test(
        "repository/domain/DB prevent source substitution, key injection and cross-project persistence",
        async () => {
          await assert.rejects(
            deriveMediaAsset(source.id, otherProject, signal(), deps),
            PermanentJobError,
          );
          assert.equal((await mediaRepo.listByMediaAsset(source.id, otherProject)).length, 0);
          const a = first[0]!;
          assert.throws(
            () =>
              new DerivedAsset(newId(), source.id, a.kind, now(), undefined, {
                ...a.artifact!,
                projectId: otherProject,
              }),
          );
          await assert.rejects(
            pool.query(
              "INSERT INTO derived_assets SELECT $1,media_asset_id,$2,kind,storage_key || 'wrong',parameter_signature,mime_type,byte_size,content_sha256,metadata,created_at,updated_at FROM derived_assets WHERE id=$3",
              [newId(), otherProject, a.id],
            ),
          );
          await assert.rejects(
            pool.query("UPDATE derived_assets SET byte_size=1 WHERE id=$1", [a.id]),
          );
          const envelope: JobEnvelope = {
            schemaVersion: 1,
            jobId: newId(),
            queueName: "media",
            jobType: "media.derive",
            idempotencyKey: "test",
            payload: {
              correlationId: "corr",
              mediaAssetId: source.id,
              projectId: project,
              version: "us128-v1",
            },
            timeoutMs: 1000,
            maxAttempts: 1,
            attempt: 1,
            backoffBaseMs: 10,
            subject: { kind: "media-asset", id: source.id },
          };
          assert.equal(validateDerivationEnvelope(envelope).mediaAssetId, source.id);
          for (const injection of [
            { ffmpegArgs: ["-i", "https://evil.test"] },
            { storageKey: "../evil" },
            { sourcePath: "/etc/passwd" },
            { presignedUrl: "https://evil.test" },
          ])
            assert.throws(
              () =>
                validateDerivationEnvelope({
                  ...envelope,
                  payload: { ...envelope.payload, ...injection },
                }),
              PermanentJobError,
            );
          assert.throws(
            () =>
              validateDerivationEnvelope({
                ...envelope,
                subject: { kind: "media-asset", id: newId() },
              }),
            PermanentJobError,
          );
          assert.throws(
            () =>
              buildDerivativeArgs(
                "https://evil.test/video",
                "/tmp/output",
                derivativePlans(source)[0]!,
              ),
            PermanentJobError,
          );
        },
      );
      await t.test("concurrent insert uniqueness restores the same logical row", async () => {
        const existing = first[0]!;
        const candidates = [0, 1].map(
          () =>
            new DerivedAsset(
              newId(),
              existing.mediaAssetId,
              existing.kind,
              now(),
              undefined,
              existing.artifact,
            ),
        );
        const inserted = await Promise.all(candidates.map((a) => mediaRepo.save(a)));
        assert.deepEqual(
          inserted.map((a) => a.id),
          [existing.id, existing.id],
        );
        assert.equal((await mediaRepo.listByMediaAsset(source.id, project)).length, 5);
      });
      await t.test(
        "deterministic parameter signature includes settings, preserves filenames out of commands/keys",
        () => {
          assert.equal(parameterSignature({ a: 1, b: 2 }), parameterSignature({ b: 2, a: 1 }));
          assert.notEqual(parameterSignature({ height: 540 }), parameterSignature({ height: 360 }));
          for (const p of derivativePlans(source)) {
            assert.ok(!p.storageKey.includes("touch"));
            assert.ok(
              !buildDerivativeArgs("/tmp/source.bin", "/tmp/out", p).some((a) =>
                a.includes("touch"),
              ),
            );
          }
        },
      );
      await t.test(
        "actual portrait, square, rotated, VFR, small/no-audio and very short sources",
        async () => {
          for (const [name, dimensions, expected] of [
            ["portrait", "720x960", [404, 540]],
            ["square", "720x720", [540, 540]],
            ["small", "160x120", [160, 120]],
          ] as const) {
            const file = path.join(directory, `${name}.mp4`);
            ffmpeg([
              "-f",
              "lavfi",
              "-i",
              `testsrc2=size=${dimensions}:rate=30:duration=0.1`,
              "-c:v",
              "libx264",
              "-preset",
              "ultrafast",
              "-pix_fmt",
              "yuv420p",
              file,
            ]);
            const asset = await persist(file);
            const outputs = await deriveMediaAsset(asset.id, project, signal(), deps);
            assert.equal(outputs.length, 3);
            const proxy = outputs.find((a) => a.kind === "proxy")!;
            assert.equal(proxy.artifact!.metadata["width"], expected[0]);
            assert.equal(proxy.artifact!.metadata["height"], expected[1]);
            assert.equal(
              outputs.some((a) => a.kind === "extracted-audio"),
              false,
            );
          }
          for (const name of ["rotated.mov", "vfr.mp4"]) {
            const asset = await persist(
              path.join(root, "packages/media-core/fixtures/media", name),
            );
            const outputs = await deriveMediaAsset(asset.id, project, signal(), deps);
            const p = outputs.find((a) => a.kind === "proxy")!;
            if (name === "rotated.mov") {
              assert.equal(p.artifact!.metadata["width"], 240);
              assert.equal(p.artifact!.metadata["height"], 320);
            }
            assert.ok(
              Math.abs(Number(p.artifact!.metadata["durationUs"]) - Number(asset.duration)) <=
                1e6 / 30,
            );
          }
          const scrubFile = path.join(directory, "scrub.mp4");
          ffmpeg([
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x120:rate=30:duration=11",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            scrubFile,
          ]);
          const scrubSource = await persist(scrubFile);
          const scrubOutputs = await deriveMediaAsset(scrubSource.id, project, signal(), deps);
          const sprite = scrubOutputs.find((a) => a.artifact!.metadata["variant"] === "sprite")!;
          const parameters = sprite.artifact!.metadata["parameters"] as Record<string, unknown>;
          assert.equal(parameters["columns"], 3);
          assert.equal(parameters["rows"], 1);
          assert.deepEqual(parameters["timestampsUs"], [1_833_333, 5_500_000, 9_166_666]);
          const spriteObject = await s3.send(
            new GetObjectCommand({ Bucket: bucket, Key: sprite.artifact!.storageKey }),
          );
          const spriteFile = path.join(directory, "scrub-sprite.jpg");
          const spriteBytes = await spriteObject.Body!.transformToByteArray();
          await import("node:fs/promises").then((fs) => fs.writeFile(spriteFile, spriteBytes));
          const spriteProbe = probe(spriteFile);
          const spriteStream = (spriteProbe["streams"] as Record<string, unknown>[])[0]!;
          assert.equal(spriteStream["width"], 480);
          assert.equal(spriteStream["height"], 90);
        },
      );
      await t.test(
        "US-129 durable media.derive publication, isolated execution and duplicate job reuse",
        async () => {
          const runtimeEnv = {
            DATABASE_URL: db.toString(),
            REDIS_URL: env.REDIS_URL,
            S3_ENDPOINT: env.S3_ENDPOINT,
            S3_BUCKET: env.S3_BUCKET,
            S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID,
            S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY,
            S3_REGION: env.S3_REGION,
            ALLOW_UNVALIDATED_DERIVATION: "true",
          };
          const savedEnv = Object.fromEntries(
            Object.keys(runtimeEnv).map((key) => [key, process.env[key]]),
          );
          Object.assign(process.env, runtimeEnv);
          const queue = new BullMqJobQueue(isolatedRedisUrl(8, env.REDIS_URL));
          const jobs = new PostgresJobRepository(pool);
          const queueName = `derive${uniqueQueueSuffix()}`;
          const jobDeps = {
            jobs,
            queue,
            supervisor: new ChildProcessJobSupervisor(),
            now,
            newAttemptId: newId,
          };
          const input = {
            jobId: newId(),
            mediaAssetId: source.id,
            projectId: project,
            correlationId: "us128-correlation",
            queueName,
          };
          try {
            const published = await publishMediaDeriveJob(jobDeps, input);
            const duplicate = await publishMediaDeriveJob(jobDeps, { ...input, jobId: newId() });
            assert.equal(duplicate.jobId, published.jobId);
            assert.equal(duplicate.duplicate, true);
            const output = await runNextJob(jobDeps, queueName, {
              modulePath: path.join(__dirname, "../handlers/media-jobs.js"),
              exportName: "handleMediaJob",
            });
            assert.equal(output, "done");
            const row = await pool.query("SELECT status FROM jobs WHERE id=$1", [published.jobId]);
            assert.equal(row.rows[0]?.status, "Completed");
            assert.equal((await mediaRepo.listByMediaAsset(source.id, project)).length, 5);
          } finally {
            await queue.close();
            for (const [key, value] of Object.entries(savedEnv)) {
              if (value === undefined) delete process.env[key];
              else process.env[key] = value;
            }
          }
        },
      );
      await t.test(
        "cancellation stops active FFmpeg, prevents records, and removes private temp output",
        async () => {
          await pool.query("DELETE FROM derived_assets WHERE media_asset_id=$1", [source.id]);
          for (const plan of derivativePlans(source))
            await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: plan.storageKey }));
          const controller = new AbortController();
          const running = deriveMediaAsset(source.id, project, controller.signal, deps);
          // Observe a real running child before requesting cancellation, not a guessed delay.
          const rejected = assert.rejects(running, /QA cancel/);
          let pid: number | undefined;
          for (let i = 0; i < 100; i++) {
            const pids = spawnSync("pgrep", ["-P", String(process.pid), "-x", "ffmpeg"], {
              encoding: "utf8",
            }).stdout.trim();
            if (pids.length > 0) {
              pid = Number(pids.split("\n")[0]);
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          assert.ok(pid !== undefined, "FFmpeg child observed before cancellation");
          controller.abort(new Error("QA cancel"));
          await rejected;
          assert.throws(() => process.kill(pid!, 0));
          assert.equal((await mediaRepo.listByMediaAsset(source.id, project)).length, 0);
          assert.equal(await objects.find(source, derivativePlans(source)[0]!, signal()), null);
          assert.equal(
            (await readdir(directory)).filter((p) => p.startsWith("editagent-probe-")).length,
            0,
          );
          const abort = new AbortController();
          abort.abort(new Error("cancel before launch"));
          await assert.rejects(
            runControlledProcess("ffmpeg", ["-version"], abort.signal, 1000),
            /cancel before launch/,
          );
        },
      );
    } finally {
      try {
        for (const key of keys)
          await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } finally {
        try {
          await rm(directory, { recursive: true, force: true });
        } finally {
          s3.destroy();
          await pool.end();
        }
      }
      const cleanup = new Pool({ connectionString: adminUrl });
      try {
        await cleanup.query(`DROP DATABASE ${database}`);
      } finally {
        await cleanup.end();
      }
    }
  },
);

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(".");
const require = createRequire(path.join(root, "apps/api/package.json"));
const domain = require(path.join(root, "packages/domain/dist/index.js"));
const { BeginMediaUpload, CompleteMediaUpload } = require(
  path.join(root, "apps/api/dist/application/uploads.js"),
);
const { applyMigrations } = require(path.join(root, "apps/api/dist/infrastructure/migrate.js"));
const { NodeMediaAssetIdGenerator } = require(
  path.join(root, "apps/api/dist/infrastructure/node-media-asset-id-generator.js"),
);
const { PostgresMediaAssetRepository } = require(
  path.join(root, "apps/api/dist/infrastructure/postgres-media-repository.js"),
);
const { PostgresProjectRepository } = require(
  path.join(root, "apps/api/dist/infrastructure/postgres-project-repository.js"),
);
const { S3ObjectStorage } = require(
  path.join(root, "apps/api/dist/infrastructure/s3-object-storage.js"),
);
const { createApiApplication } = require(
  path.join(root, "apps/api/dist/create-api-application.js"),
);
const { bindActor } = require(path.join(root, "apps/api/dist/presentation/actor.js"));
const { inspectMediaAsset } = require(
  path.join(root, "workers/media-worker/dist/application/inspect-media.js"),
);
const { PostgresMediaInspectionRepository } = require(
  path.join(
    root,
    "workers/media-worker/dist/infrastructure/postgres-media-inspection-repository.js",
  ),
);
const { Pool } = require("pg");

const TEST_DATABASE = "editagent_us126";
const OWNER = domain.userId("018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f");
const EDITOR = domain.userId("018f6b6e-7c3a-7222-8d3e-9c0b1a2d3e4f");
const VIEWER = domain.userId("018f6b6e-7c3a-7333-8d3e-9c0b1a2d3e4f");
const STRANGER = domain.userId("018f6b6e-7c3a-7444-8d3e-9c0b1a2d3e4f");
const PROJECT = domain.projectId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f");
const OTHER = domain.projectId("018f6b6e-7c3a-7b2b-8d3e-9c0b1a2d3e4f");
const FIXTURES = path.resolve("packages/media-core/fixtures/media");
const INSPECT = path.resolve("workers/media-worker/dist/inspect.js");

function adminUrl() {
  return (
    process.env.DATABASE_URL ??
    "postgresql://editagent:editagent-dev-password@127.0.0.1:5432/editagent"
  );
}

function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function storageConfig() {
  return {
    endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? "http://127.0.0.1:9000",
    bucket: process.env.S3_BUCKET ?? "editagent",
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "editagent",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "editagent-dev-secret",
    region: process.env.S3_REGION ?? "us-east-1",
  };
}

describe("FFprobe inspection against PostgreSQL and MinIO", { concurrency: 1 }, () => {
  let pool;
  let projects;
  let media;
  let objects;
  let begin;
  let complete;
  let app;
  let base;
  let tempRoot;
  const config = storageConfig();
  const databaseUrl = withDatabase(adminUrl(), TEST_DATABASE);

  before(async () => {
    const admin = new Pool({ connectionString: adminUrl() });
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
    await admin.end();
    pool = new Pool({ connectionString: databaseUrl });
    await applyMigrations(pool);
    projects = new PostgresProjectRepository(pool);
    media = new PostgresMediaAssetRepository(pool);
    objects = new S3ObjectStorage(config);
    await objects.ensureBucket();
    const clock = { now: () => domain.instant(1_700_000_000_000n) };
    begin = new BeginMediaUpload(projects, objects, clock, 900);
    complete = new CompleteMediaUpload(
      projects,
      media,
      objects,
      new NodeMediaAssetIdGenerator(),
      clock,
    );
    await projects.save(domain.Project.create(PROJECT, "Launch", OWNER, clock.now()), null);
    let loaded = await projects.findById(PROJECT);
    const withEditor = loaded.project.grantMembership(
      OWNER,
      EDITOR,
      "editor",
      domain.instant(1_700_000_000_010n),
    );
    await projects.save(withEditor, loaded.revision);
    loaded = await projects.findById(PROJECT);
    const withViewer = loaded.project.grantMembership(
      OWNER,
      VIEWER,
      "viewer",
      domain.instant(1_700_000_000_020n),
    );
    await projects.save(withViewer, loaded.revision);
    await projects.save(domain.Project.create(OTHER, "Other", STRANGER, clock.now()), null);
    tempRoot = mkdtempSync(path.join(tmpdir(), "editagent-us126-"));
    app = await createApiApplication(
      {
        projects,
        clock,
        ids: { next: () => PROJECT },
        media,
        objects,
        mediaIds: new NodeMediaAssetIdGenerator(),
        presignTtlSeconds: 900,
      },
      (use) => {
        use((request, _response, next) => {
          const header = request.headers?.["x-test-actor"];
          if (typeof header === "string") {
            bindActor(request, domain.userId(header));
          }
          next();
        });
      },
    );
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await app.close();
    await pool.end();
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("upload, real FFprobe, a new repository, and the media details API agree", async () => {
    const normal = await upload("normal.mp4", "video/mp4");
    const rotated = await upload("rotated.mov", "video/quicktime");
    const vfr = await upload("vfr.mp4", "video/mp4");
    const multi = await upload("multi.mp4", "video/mp4");
    const corrupt = await upload("corrupt.mp4", "video/mp4");
    for (const asset of [normal, rotated, vfr, multi, corrupt]) {
      assert.equal(asset.duration, null);
      assert.equal(asset.inspectionStatus, "pending");
    }
    const beforeProbe = await media.findById(normal.id);
    assert.equal(beforeProbe.duration, null);
    assert.equal(beforeProbe.inspectionStatus, "pending");

    const normalRun = inspect(normal.id);
    assert.equal(normalRun.status, 0, `${normalRun.stdout}\n${normalRun.stderr}`);
    assert.equal(normalRun.stdout.includes(config.secretAccessKey), false);
    assert.equal(normalRun.stdout.includes("source.bin"), false);
    const rotatedRun = inspect(rotated.id);
    assert.equal(rotatedRun.status, 0, rotatedRun.stderr);
    const vfrRun = inspect(vfr.id);
    assert.equal(vfrRun.status, 0, vfrRun.stderr);
    const multiRun = inspect(multi.id);
    assert.equal(multiRun.status, 0, multiRun.stderr);
    const corruptRun = inspect(corrupt.id);
    assert.equal(corruptRun.status, 1);
    assert.match(corruptRun.stdout, /failed invalid_result/);
    assert.equal(corruptRun.stderr.includes("ffprobe"), false);

    const freshPool = new Pool({ connectionString: databaseUrl });
    const fresh = new PostgresMediaAssetRepository(freshPool);
    try {
      const stored = await fresh.findById(normal.id);
      assert.equal(stored.videoCodec, "h264");
      assert.equal(stored.duration, 1_000_000n);
      assert.equal(stored.inspectionStatus, "completed");
      const turned = await fresh.findById(rotated.id);
      assert.equal(turned.container, "MOV");
      assert.equal(turned.rotation, 90);
      assert.equal(turned.displayWidth, 240);
      assert.equal(turned.displayHeight, 320);
      assert.equal(turned.width, 320);
      assert.equal(turned.height, 240);
    } finally {
      await freshPool.end();
    }

    const owner = await readMedia(OWNER, PROJECT, normal.id);
    assert.equal(owner.status, 200);
    const body = await owner.json();
    assert.equal(body.container, "MP4");
    assert.equal(body.videoCodec, "h264");
    assert.equal(body.audioCodec, "aac");
    assert.equal(body.width, 320);
    assert.equal(body.height, 240);
    assert.equal(body.displayWidth, 320);
    assert.equal(body.displayHeight, 240);
    assert.equal(body.rotation, null);
    assert.equal(body.frameRateNumerator, "25");
    assert.equal(body.frameRateDenominator, "1");
    assert.equal(body.frameRateMode, "constant");
    assert.equal(body.duration, "1000000");
    assert.equal(body.audioChannels, 1);
    assert.equal(body.sampleRate, 48000);
    assert.equal(body.inspectionStatus, "completed");
    assert.equal(body.storageKey, undefined);

    const portrait = await (await readMedia(EDITOR, PROJECT, rotated.id)).json();
    assert.equal(portrait.displayWidth, 240);
    assert.equal(portrait.displayHeight, 320);
    assert.equal(portrait.rotation, 90);
    assert.equal(portrait.container, "MOV");
    const variable = await (await readMedia(VIEWER, PROJECT, vfr.id)).json();
    assert.equal(variable.frameRateMode, "variable");
    assert.equal(variable.frameRateNumerator, "125");
    assert.equal(variable.frameRateDenominator, "9");
    assert.equal(variable.duration, "360000");
    const streams = await (await readMedia(OWNER, PROJECT, multi.id)).json();
    assert.equal(streams.streams.length, 3);
    assert.equal(streams.sampleRate, 48000);
    assert.equal(streams.streams[2].sampleRate, 44100);

    assert.equal((await readMedia(null, PROJECT, normal.id)).status, 401);
    assert.equal((await readMedia(STRANGER, PROJECT, normal.id)).status, 404);
    assert.equal((await readMedia(OWNER, OTHER, normal.id)).status, 404);

    const broken = await (await readMedia(OWNER, PROJECT, corrupt.id)).json();
    assert.equal(broken.inspectionStatus, "failed");
    assert.equal(broken.inspectionError, "invalid_result");
    assert.equal(broken.duration, null);
    assert.equal(broken.videoCodec, null);
    assert.equal(JSON.stringify(broken).includes("Invalid data"), false);
    const corruptStat = await objects.stat(corrupt.storageKey);
    assert.equal(corruptStat === null, false);

    const workerPool = new Pool({ connectionString: databaseUrl });
    try {
      const workerMedia = new PostgresMediaInspectionRepository(workerPool);
      const current = await workerMedia.findById(normal.id);
      const preserved = await inspectMediaAsset(normal.id, {
        media: workerMedia,
        staging: {
          async stage() {
            return { filePath: "/tmp/unused", async release() {} };
          },
        },
        probe: {
          async inspect() {
            throw new domain.MediaProbeError("timeout");
          },
        },
        clock: { now: () => domain.instant(BigInt(Date.now())) },
      });
      assert.equal(preserved.inspectionStatus, "completed");
      const still = await workerMedia.findById(normal.id);
      assert.equal(still.inspectionStatus, "completed");
      assert.equal(still.videoCodec, "h264");
      assert.equal(still.updatedAt, current.updatedAt);
      const stale = domain.MediaAsset.restore({
        ...current.toSnapshot(),
        inspectionStatus: "failed",
        inspectionError: "timeout",
        container: null,
        videoCodec: null,
        audioCodec: null,
        width: null,
        height: null,
        displayWidth: null,
        displayHeight: null,
        rotation: null,
        frameRateNumerator: null,
        frameRateDenominator: null,
        frameRateMode: null,
        colorSpace: null,
        audioChannels: null,
        sampleRate: null,
        streams: null,
        duration: null,
        updatedAt: domain.instant(BigInt(Date.now())),
      });
      await assert.rejects(
        () => workerMedia.saveInspection(stale, domain.instant(1_700_000_000_000n)),
        domain.MediaInspectionConflict,
      );
      const unchanged = await new PostgresMediaAssetRepository(workerPool).findById(normal.id);
      assert.equal(unchanged.videoCodec, "h264");
      assert.equal(unchanged.duration, 1_000_000n);
      const latest = await media.findById(normal.id);
      const rewritten = latest.recordInspection(
        {
          container: latest.container,
          videoCodec: latest.videoCodec,
          audioCodec: latest.audioCodec,
          width: latest.width,
          height: latest.height,
          displayWidth: latest.displayWidth,
          displayHeight: latest.displayHeight,
          rotation: latest.rotation,
          frameRate:
            latest.frameRateNumerator === null
              ? null
              : {
                  numerator: latest.frameRateNumerator,
                  denominator: latest.frameRateDenominator,
                },
          frameRateMode: latest.frameRateMode,
          duration: latest.duration,
          colorSpace: latest.colorSpace,
          audioChannels: latest.audioChannels,
          sampleRate: latest.sampleRate,
          streams: latest.streams ?? [],
        },
        domain.instant(BigInt(Date.now())),
      );
      await media.saveInspection(rewritten, latest.updatedAt);
      const throughApi = await media.findById(normal.id);
      assert.equal(throughApi.videoCodec, "h264");
      assert.equal(throughApi.duration, 1_000_000n);
      assert.equal(throughApi.frameRateNumerator, 25n);
    } finally {
      await workerPool.end();
    }

    const left = await readdir(tempRoot);
    assert.deepEqual(
      left.filter((entry) => entry.startsWith("editagent-probe-")),
      [],
    );
  });

  async function upload(filename, mimeType) {
    const body = readFileSync(path.join(FIXTURES, filename));
    const hash = createHash("sha256").update(body).digest("hex");
    await objects.delete(domain.mediaStorageKey(PROJECT, hash));
    const started = await begin.execute(OWNER, PROJECT, {
      filename,
      mimeType,
      byteSize: body.byteLength,
      sha256: hash,
    });
    const put = await fetch(started.uploadUrl, {
      method: "PUT",
      headers: started.requiredHeaders,
      body,
    });
    assert.equal(put.status, 200, await put.text());
    return complete.execute(OWNER, PROJECT, {
      filename,
      mimeType,
      byteSize: body.byteLength,
      sha256: hash,
    });
  }

  function inspect(id) {
    return spawnSync(process.execPath, [INSPECT, id], {
      cwd: path.resolve("workers/media-worker"),
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: databaseUrl,
        REDIS_URL: "redis://127.0.0.1:6379/0",
        S3_ENDPOINT: config.endpoint,
        S3_BUCKET: config.bucket,
        S3_ACCESS_KEY_ID: config.accessKeyId,
        S3_SECRET_ACCESS_KEY: config.secretAccessKey,
        S3_REGION: config.region,
        FFPROBE_PATH: "ffprobe",
        PROBE_TMPDIR: tempRoot,
      },
      encoding: "utf8",
      timeout: 60_000,
    });
  }

  function readMedia(actor, projectId, mediaAssetId) {
    const headers = actor === null ? {} : { "x-test-actor": actor };
    return fetch(`${base}/projects/${projectId}/media/${mediaAssetId}`, { headers });
  }
});

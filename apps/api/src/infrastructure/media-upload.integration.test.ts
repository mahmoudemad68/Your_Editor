import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  instant,
  type Instant,
  mediaStorageKey,
  Project,
  projectId,
  userId,
  uuidV7,
} from "@editagent/domain";
import { Pool } from "pg";
import { type Clock } from "../application/clock.js";
import { ProjectNotFoundError } from "../application/project-access.js";
import { UploadObjectMissing, UploadPolicyError } from "../application/upload-errors.js";
import { BeginMediaUpload, CompleteMediaUpload } from "../application/uploads.js";
import { applyMigrations } from "./migrate.js";
import { NodeMediaAssetIdGenerator } from "./node-media-asset-id-generator.js";
import { PostgresMediaAssetRepository } from "./postgres-media-repository.js";
import { PostgresProjectRepository } from "./postgres-project-repository.js";
import { S3ObjectStorage } from "./s3-object-storage.js";

const TEST_DATABASE = "editagent_us122";
const OWNER = userId("018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f");
const OTHER_USER = userId("018f6b6e-7c3a-7222-8d3e-9c0b1a2d3e4f");
const PROJECT = projectId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f");
const OTHER_PROJECT = projectId("018f6b6e-7c3a-7b2b-8d3e-9c0b1a2d3e4f");

class FixedClock implements Clock {
  now(): Instant {
    return instant(10n);
  }
}

function adminUrl(): string {
  return (
    process.env["DATABASE_URL"] ??
    "postgresql://editagent:editagent-dev-password@127.0.0.1:5432/editagent"
  );
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
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("direct media upload against PostgreSQL and MinIO", { concurrency: 1 }, () => {
  let pool: Pool;
  let projects: PostgresProjectRepository;
  let media: PostgresMediaAssetRepository;
  let objects: S3ObjectStorage;
  let begin: BeginMediaUpload;
  let complete: CompleteMediaUpload;
  const config = storageConfig();

  before(async () => {
    const admin = new Pool({ connectionString: adminUrl() });
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
    await admin.end();
    pool = new Pool({ connectionString: withDatabase(adminUrl(), TEST_DATABASE) });
    await applyMigrations(pool);
    projects = new PostgresProjectRepository(pool);
    media = new PostgresMediaAssetRepository(pool);
    objects = new S3ObjectStorage(config);
    await objects.ensureBucket();
    const clock = new FixedClock();
    begin = new BeginMediaUpload(projects, objects, clock, 900);
    complete = new CompleteMediaUpload(
      projects,
      media,
      objects,
      new NodeMediaAssetIdGenerator(),
      clock,
    );
    await projects.save(Project.create(PROJECT, "Launch", OWNER, instant(10n)), null);
    await projects.save(Project.create(OTHER_PROJECT, "Other", OTHER_USER, instant(10n)), null);
  });

  after(async () => {
    await pool.end();
  });

  test("a browser PUT to the presigned URL creates a linked MediaAsset", async () => {
    const body = Buffer.from("editagent-fixture-video");
    const hash = sha256(body);
    const started = await begin.execute(OWNER, PROJECT, {
      filename: "lecture.mp4",
      mimeType: "video/mp4",
      byteSize: body.byteLength,
      sha256: hash,
    });
    assert.equal(started.uploadUrl.startsWith(config.publicEndpoint), true);
    assert.equal(started.uploadUrl.includes("minio:"), false);
    assert.equal(started.storageKey, mediaStorageKey(PROJECT, hash));
    const uploaded = await fetch(started.uploadUrl, {
      method: "PUT",
      headers: started.requiredHeaders,
      body,
    });
    assert.equal(uploaded.status, 200, await uploaded.text());
    const asset = await complete.execute(OWNER, PROJECT, {
      filename: "lecture.mp4",
      mimeType: "video/mp4",
      byteSize: body.byteLength,
      sha256: hash,
    });
    assert.equal(asset.projectId, PROJECT);
    assert.equal(asset.storageKey, started.storageKey);
    assert.equal(asset.displayFilename, "lecture.mp4");
    assert.equal(asset.id, uuidV7(asset.id));
    const stored = await media.findById(asset.id);
    assert.equal(stored?.contentSha256, hash);
    assert.equal(stored?.duration, null);
    const stat = await objects.stat(started.storageKey);
    assert.equal(stat?.byteSize, BigInt(body.byteLength));
    assert.equal(stat?.checksumSha256Hex, hash);
    const row = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM media_assets WHERE id = $1 AND project_id = $2",
      [asset.id, PROJECT],
    );
    assert.equal(row.rows[0]?.count, "1");
  });

  test("a path-like filename stays display metadata", async () => {
    const body = Buffer.from("editagent-traversal-video");
    const hash = sha256(body);
    const filename = "../../etc/passwd";
    const started = await begin.execute(OWNER, PROJECT, {
      filename,
      mimeType: "video/mp4",
      byteSize: body.byteLength,
      sha256: hash,
    });
    assert.equal(started.storageKey.includes(".."), false);
    assert.equal(started.storageKey.includes("etc"), false);
    assert.equal(started.storageKey.includes("passwd"), false);
    assert.equal(started.uploadUrl.includes("passwd"), false);
    const uploaded = await fetch(started.uploadUrl, {
      method: "PUT",
      headers: started.requiredHeaders,
      body,
    });
    assert.equal(uploaded.status, 200, await uploaded.text());
    const asset = await complete.execute(OWNER, PROJECT, {
      filename,
      mimeType: "video/mp4",
      byteSize: body.byteLength,
      sha256: hash,
    });
    assert.equal(asset.displayFilename, filename);
    assert.equal(asset.storageKey, `projects/${PROJECT}/media/sha256/${hash}`);
    assert.equal(await objects.stat(`projects/${PROJECT}/uploads/passwd`), null);
  });

  test("a checksum mismatch is rejected and does not create a MediaAsset", async () => {
    const declared = Buffer.from("editagent-checksum-video");
    const hash = sha256(declared);
    const started = await begin.execute(OWNER, PROJECT, {
      filename: "checksum.mp4",
      mimeType: "video/mp4",
      byteSize: declared.byteLength,
      sha256: hash,
    });
    const tampered = Buffer.from("editagent-checksum-XXXXX");
    const rejected = await fetch(started.uploadUrl, {
      method: "PUT",
      headers: started.requiredHeaders,
      body: tampered,
    });
    assert.notEqual(rejected.ok, true);
    await assert.rejects(
      () =>
        complete.execute(OWNER, PROJECT, {
          filename: "checksum.mp4",
          mimeType: "video/mp4",
          byteSize: declared.byteLength,
          sha256: hash,
        }),
      UploadObjectMissing,
    );
    assert.equal(await objects.stat(started.storageKey), null);
    const rows = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM media_assets WHERE content_sha256 = $1",
      [hash],
    );
    assert.equal(rows.rows[0]?.count, "0");
  });

  test("completion rejects a missing object and another user's Project", async () => {
    const hash = "cd".repeat(32);
    await assert.rejects(
      () =>
        complete.execute(OWNER, PROJECT, {
          filename: "missing.mp4",
          mimeType: "video/mp4",
          byteSize: 8,
          sha256: hash,
        }),
      UploadObjectMissing,
    );
    await assert.rejects(
      () =>
        begin.execute(OWNER, OTHER_PROJECT, {
          filename: "lecture.mp4",
          mimeType: "video/mp4",
          byteSize: 8,
          sha256: hash,
        }),
      ProjectNotFoundError,
    );
    await assert.rejects(
      () =>
        begin.execute(OWNER, PROJECT, {
          filename: "clip.avi",
          mimeType: "video/x-msvideo",
          byteSize: 8,
          sha256: hash,
        }),
      UploadPolicyError,
    );
  });
});

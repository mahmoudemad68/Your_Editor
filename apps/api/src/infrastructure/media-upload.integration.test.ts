import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  instant,
  type Instant,
  MediaAssetConflict,
  mediaStorageKey,
  Project,
  projectId,
  userId,
  uuidV7,
} from "@editagent/domain";
import { Pool } from "pg";
import { type Clock } from "../application/clock.js";
import { ProjectNotFoundError } from "../application/project-access.js";
import {
  UploadObjectMismatch,
  UploadObjectMissing,
  UploadPolicyError,
} from "../application/upload-errors.js";
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

function signedHeaderNames(url: string): string[] {
  const value = new URL(url).searchParams.get("X-Amz-SignedHeaders") ?? "";
  return value.split(";").filter((name) => name.length > 0);
}

async function forget(storage: S3ObjectStorage, hash: string): Promise<void> {
  await storage.delete(mediaStorageKey(PROJECT, hash));
}

async function putObject(
  url: string,
  headers: Readonly<Record<string, string>>,
  body: Buffer,
): Promise<Response> {
  return fetch(url, { method: "PUT", headers, body });
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
    await forget(objects, hash);
    const started = await begin.execute(OWNER, PROJECT, {
      filename: "lecture.mp4",
      mimeType: "video/mp4",
      byteSize: body.byteLength,
      sha256: hash,
    });
    assert.equal(started.uploadUrl.startsWith(config.publicEndpoint), true);
    assert.equal(started.uploadUrl.includes("minio:"), false);
    assert.equal(started.storageKey, mediaStorageKey(PROJECT, hash));
    assert.equal(started.requiredHeaders["Content-Type"], "video/mp4");
    assert.equal(started.requiredHeaders["If-None-Match"], "*");
    assert.equal(typeof started.requiredHeaders["x-amz-checksum-sha256"], "string");
    const signed = signedHeaderNames(started.uploadUrl);
    for (const name of ["host", "content-type", "if-none-match", "x-amz-checksum-sha256"]) {
      assert.equal(signed.includes(name), true, signed.join(";"));
    }
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
    assert.equal(stored?.inspectionStatus, "pending");
    assert.equal(stored?.videoCodec, null);
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
    await forget(objects, hash);
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
    await forget(objects, sha256(declared));
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

  test("the presigned PUT requires the checksum, content type, and If-None-Match headers", async () => {
    const body = Buffer.from("A");
    const other = Buffer.from("B");
    const hash = sha256(body);
    await forget(objects, hash);
    const started = await begin.execute(OWNER, PROJECT, {
      filename: "signed.mp4",
      mimeType: "video/mp4",
      byteSize: body.byteLength,
      sha256: hash,
    });
    const headers = { ...started.requiredHeaders };
    const withoutChecksum = { ...headers };
    delete withoutChecksum["x-amz-checksum-sha256"];
    const omitted = await putObject(started.uploadUrl, withoutChecksum, other);
    assert.equal(omitted.ok, false);

    const changedChecksum = await putObject(
      started.uploadUrl,
      { ...headers, "x-amz-checksum-sha256": sha256(other) },
      other,
    );
    assert.equal(changedChecksum.ok, false);

    const changedType = await putObject(
      started.uploadUrl,
      { ...headers, "Content-Type": "video/webm" },
      body,
    );
    assert.equal(changedType.ok, false);

    const withoutCondition = { ...headers };
    delete withoutCondition["If-None-Match"];
    const omittedCondition = await putObject(started.uploadUrl, withoutCondition, body);
    assert.equal(omittedCondition.ok, false);

    const changedCondition = await putObject(
      started.uploadUrl,
      { ...headers, "If-None-Match": '"abc"' },
      body,
    );
    assert.equal(changedCondition.ok, false);

    const accepted = await putObject(started.uploadUrl, headers, body);
    assert.equal(accepted.status, 200, await accepted.text());
    const stat = await objects.stat(started.storageKey);
    assert.equal(stat?.checksumSha256Hex, hash);
    assert.equal(stat?.byteSize, 1n);
    assert.equal(
      await media
        .listByProject(PROJECT)
        .then((rows) => rows.some((row) => row.contentSha256 === hash)),
      false,
    );
  });

  test("a wrong body sent with the declared checksum is rejected", async () => {
    const declared = Buffer.from("A-declared");
    const other = Buffer.from("B-other");
    const hash = sha256(declared);
    await forget(objects, hash);
    const started = await begin.execute(OWNER, PROJECT, {
      filename: "checksum-body.mp4",
      mimeType: "video/mp4",
      byteSize: declared.byteLength,
      sha256: hash,
    });
    const rejected = await putObject(started.uploadUrl, started.requiredHeaders, other);
    assert.equal(rejected.ok, false);
    assert.equal(await objects.stat(started.storageKey), null);
    const rows = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM media_assets WHERE content_sha256 = $1",
      [hash],
    );
    assert.equal(rows.rows[0]?.count, "0");
  });

  test("a later upload cannot overwrite the canonical object or its MIME type", async () => {
    const body = Buffer.from("canonical-bytes");
    const hash = sha256(body);
    await forget(objects, hash);
    const first = await begin.execute(OWNER, PROJECT, {
      filename: "original.mp4",
      mimeType: "video/mp4",
      byteSize: body.byteLength,
      sha256: hash,
    });
    const created = await putObject(first.uploadUrl, first.requiredHeaders, body);
    assert.equal(created.status, 200, await created.text());
    const asset = await complete.execute(OWNER, PROJECT, {
      filename: "original.mp4",
      mimeType: "video/mp4",
      byteSize: body.byteLength,
      sha256: hash,
    });
    const second = await begin.execute(OWNER, PROJECT, {
      filename: "again.webm",
      mimeType: "video/webm",
      byteSize: body.byteLength,
      sha256: hash,
    });
    const overwritten = await putObject(second.uploadUrl, second.requiredHeaders, body);
    assert.equal(overwritten.ok, false);
    const stat = await objects.stat(first.storageKey);
    assert.equal(stat?.contentType, "video/mp4");
    assert.equal(stat?.checksumSha256Hex, hash);
    assert.deepEqual(Buffer.from(await objects.get(first.storageKey)), body);
    const stored = await media.findById(asset.id);
    assert.equal(stored?.mimeType, "video/mp4");
    assert.equal(stored?.byteSize, BigInt(body.byteLength));
  });

  test("a mismatched completion leaves the canonical object and MediaAsset in place", async () => {
    const body = Buffer.from("preserve-me");
    const hash = sha256(body);
    await forget(objects, hash);
    const started = await begin.execute(OWNER, PROJECT, {
      filename: "keep.mp4",
      mimeType: "video/mp4",
      byteSize: body.byteLength,
      sha256: hash,
    });
    assert.equal((await putObject(started.uploadUrl, started.requiredHeaders, body)).status, 200);
    const asset = await complete.execute(OWNER, PROJECT, {
      filename: "keep.mp4",
      mimeType: "video/mp4",
      byteSize: body.byteLength,
      sha256: hash,
    });
    await assert.rejects(
      () =>
        complete.execute(OWNER, PROJECT, {
          filename: "keep.mp4",
          mimeType: "video/mp4",
          byteSize: body.byteLength + 1,
          sha256: hash,
        }),
      UploadObjectMismatch,
    );
    await assert.rejects(
      () =>
        complete.execute(OWNER, PROJECT, {
          filename: "keep.webm",
          mimeType: "video/webm",
          byteSize: body.byteLength,
          sha256: hash,
        }),
      UploadObjectMismatch,
    );
    await assert.rejects(
      () =>
        complete.execute(OWNER, PROJECT, {
          filename: "keep.mp4",
          mimeType: "video/mp4",
          byteSize: body.byteLength,
          sha256: hash,
        }),
      MediaAssetConflict,
    );
    const stat = await objects.stat(started.storageKey);
    assert.equal(stat?.contentType, "video/mp4");
    assert.equal(stat?.checksumSha256Hex, hash);
    assert.equal(stat?.byteSize, BigInt(body.byteLength));
    const stored = await media.findById(asset.id);
    assert.equal(stored?.mimeType, "video/mp4");
    assert.equal(stored?.duration, null);
    assert.equal(stored?.projectId, PROJECT);
    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM media_assets WHERE project_id = $1 AND content_sha256 = $2",
      [PROJECT, hash],
    );
    assert.equal(count.rows[0]?.count, "1");
  });

  test("concurrent conditional PUTs create the object once", async () => {
    const body = Buffer.from("race-bytes");
    const hash = sha256(body);
    await forget(objects, hash);
    const mp4 = await begin.execute(OWNER, PROJECT, {
      filename: "race.mp4",
      mimeType: "video/mp4",
      byteSize: body.byteLength,
      sha256: hash,
    });
    const webm = await begin.execute(OWNER, PROJECT, {
      filename: "race.webm",
      mimeType: "video/webm",
      byteSize: body.byteLength,
      sha256: hash,
    });
    const [left, right] = await Promise.all([
      putObject(mp4.uploadUrl, mp4.requiredHeaders, body),
      putObject(webm.uploadUrl, webm.requiredHeaders, body),
    ]);
    const statuses = [left.status, right.status].sort((a, b) => a - b);
    assert.equal(statuses[0], 200);
    assert.notEqual(statuses[1], 200);
    const stat = await objects.stat(mp4.storageKey);
    assert.equal(stat?.checksumSha256Hex, hash);
    assert.deepEqual(Buffer.from(await objects.get(mp4.storageKey)), body);
    assert.equal(stat?.contentType === "video/mp4" || stat?.contentType === "video/webm", true);
  });

  test("a mismatched completion racing a correct one does not delete the object", async () => {
    const body = Buffer.from("complete-race");
    const hash = sha256(body);
    await forget(objects, hash);
    const started = await begin.execute(OWNER, PROJECT, {
      filename: "race-complete.mp4",
      mimeType: "video/mp4",
      byteSize: body.byteLength,
      sha256: hash,
    });
    assert.equal((await putObject(started.uploadUrl, started.requiredHeaders, body)).status, 200);
    const results = await Promise.allSettled([
      complete.execute(OWNER, PROJECT, {
        filename: "race-complete.mp4",
        mimeType: "video/mp4",
        byteSize: body.byteLength,
        sha256: hash,
      }),
      complete.execute(OWNER, PROJECT, {
        filename: "race-complete.webm",
        mimeType: "video/webm",
        byteSize: body.byteLength,
        sha256: hash,
      }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const stat = await objects.stat(started.storageKey);
    assert.equal(stat?.contentType, "video/mp4");
    assert.equal(stat?.checksumSha256Hex, hash);
    const rows = await pool.query<{ count: string; mime_type: string }>(
      "SELECT count(*)::text AS count, min(mime_type) AS mime_type FROM media_assets WHERE content_sha256 = $1",
      [hash],
    );
    assert.equal(rows.rows[0]?.count, "1");
    assert.equal(rows.rows[0]?.mime_type, "video/mp4");
  });

  test("the browser preflight allows the repaired upload headers", async () => {
    const body = Buffer.from("cors-bytes");
    const hash = sha256(body);
    await forget(objects, hash);
    const started = await begin.execute(OWNER, PROJECT, {
      filename: "cors.mp4",
      mimeType: "video/mp4",
      byteSize: body.byteLength,
      sha256: hash,
    });
    const preflight = await fetch(started.uploadUrl, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type,x-amz-checksum-sha256,if-none-match",
      },
    });
    assert.equal(preflight.ok, true, await preflight.text());
    const allowed = (preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    assert.equal(allowed.includes("content-type"), true, allowed);
    assert.equal(allowed.includes("x-amz-checksum-sha256"), true, allowed);
    assert.equal(allowed.includes("if-none-match"), true, allowed);
    const uploaded = await fetch(started.uploadUrl, {
      method: "PUT",
      headers: { ...started.requiredHeaders, Origin: "http://localhost:3000" },
      body,
    });
    assert.equal(uploaded.status, 200, await uploaded.text());
    assert.equal(
      (uploaded.headers.get("access-control-allow-origin") ?? "").includes(
        "http://localhost:3000",
      ) || uploaded.headers.get("access-control-allow-origin") === "*",
      true,
    );
    const anonymous = await fetch(
      `${config.publicEndpoint}/${config.bucket}/${started.storageKey}`,
    );
    assert.equal(anonymous.ok, false);
  });
});

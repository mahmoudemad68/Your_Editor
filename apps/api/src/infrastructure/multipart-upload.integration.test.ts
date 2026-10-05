import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { before, after, test } from "node:test";
import { Pool } from "pg";
import {
  Project,
  createUuidV7,
  projectId,
  userId,
  instant,
  PART_SIZE_BYTES,
  UPLOAD_SESSION_TTL_MS,
} from "@editagent/domain";
import { applyMigrations } from "./migrate.js";
import { BullMqJobQueue, PostgresJobRepository } from "@editagent/job-queue";
import { PostgresUploadPublication } from "./postgres-upload-publication.js";
import { PostgresUploadSessionRepository } from "./postgres-upload-sessions.js";
import { PostgresProjectRepository } from "./postgres-project-repository.js";
import { PostgresMediaAssetRepository } from "./postgres-media-repository.js";
import { NodeMediaAssetIdGenerator } from "./node-media-asset-id-generator.js";
import { NodeProjectIdGenerator } from "./node-project-id-generator.js";
import { S3ObjectStorage } from "./s3-object-storage.js";
import { JwtSessionTokens } from "./jwt-session-tokens.js";
import { Argon2idHasher } from "./argon2id-hasher.js";
import { GetCurrentUser } from "../application/current-user.js";
import {
  InMemoryUserRepository,
  InMemoryRefreshSessionRepository,
} from "../application/in-memory-identity.js";
import {
  RegisterUser,
  LoginUser,
  RefreshAccess,
  LogoutUser,
} from "../application/authentication.js";
import { LoginRateLimit } from "../application/login-rate-limit.js";
import { MultipartUploads } from "../application/multipart-uploads.js";
import { createApiApplication } from "../create-api-application.js";
import { UploadObjectMismatch } from "../application/upload-errors.js";
const OWNER = userId("018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f"),
  EDITOR = userId("018f6b6e-7c3a-7222-8d3e-9c0b1a2d3e4f"),
  VIEWER = userId("018f6b6e-7c3a-7333-8d3e-9c0b1a2d3e4f"),
  STRANGER = userId("018f6b6e-7c3a-7444-8d3e-9c0b1a2d3e4f");
const PROJECT = projectId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f"),
  OTHER = projectId("018f6b6e-7c3a-7b2b-8d3e-9c0b1a2d3e4f");
let queue: BullMqJobQueue, publication: PostgresUploadPublication;
let pool: Pool,
  objects: S3ObjectStorage,
  repository: PostgresUploadSessionRepository,
  service: MultipartUploads,
  now = instant(BigInt(Date.now()));
let app: Awaited<ReturnType<typeof createApiApplication>>, base: string, tokens: JwtSessionTokens;
const keys = new Set<string>();
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
before(async () => {
  const url =
    process.env["DATABASE_URL"] ??
    "postgresql://editagent:editagent-dev-password@localhost:5432/editagent";
  const admin = new Pool({ connectionString: url });
  await admin.query("DROP DATABASE IF EXISTS editagent_us123 WITH (FORCE)");
  await admin.query("CREATE DATABASE editagent_us123");
  await admin.end();
  const parsed = new URL(url);
  parsed.pathname = "/editagent_us123";
  pool = new Pool({ connectionString: parsed.toString() });
  await applyMigrations(pool);
  for (const id of [OWNER, EDITOR, VIEWER, STRANGER])
    await pool.query(
      "INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES($1,$2,$3,$4,$4)",
      [id, `${id}@example.test`, "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA", now.toString()],
    );
  const projects = new PostgresProjectRepository(pool),
    media = new PostgresMediaAssetRepository(pool);
  const p = Project.create(PROJECT, "Multipart", OWNER, now)
    .grantMembership(OWNER, EDITOR, "editor", now)
    .grantMembership(OWNER, VIEWER, "viewer", now);
  await projects.save(p, null);
  await projects.save(Project.create(OTHER, "Other", OWNER, now), null);
  objects = new S3ObjectStorage({
    endpoint: process.env["S3_ENDPOINT"] ?? "http://127.0.0.1:9000",
    publicEndpoint: process.env["S3_PUBLIC_ENDPOINT"] ?? "http://127.0.0.1:9000",
    bucket: process.env["S3_BUCKET"] ?? "editagent",
    accessKeyId: process.env["S3_ACCESS_KEY_ID"] ?? "editagent",
    secretAccessKey: process.env["S3_SECRET_ACCESS_KEY"] ?? "editagent-dev-secret",
    region: process.env["S3_REGION"] ?? "us-east-1",
  });
  await objects.ensureBucket();
  repository = new PostgresUploadSessionRepository(pool);
  const clock = { now: () => now };
  queue = new BullMqJobQueue(process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379/0");
  publication = new PostgresUploadPublication({
    pool,
    jobs: new PostgresJobRepository(pool),
    queue,
    now: () => now,
    newJobId: () => createUuidV7(Number(now), randomBytes(10)),
    newAttemptId: () => createUuidV7(Number(now), randomBytes(10)),
    queueName: `us123.multipart.inspect.${Date.now()}`,
  });
  service = new MultipartUploads(
    projects,
    repository,
    objects,
    media,
    new NodeMediaAssetIdGenerator(),
    clock,
    900,
    publication,
  );
  tokens = new JwtSessionTokens("us123-integration-signing-key-at-least-32chars");
  const users = new InMemoryUserRepository(),
    refreshSessions = new InMemoryRefreshSessionRepository(),
    passwords = new Argon2idHasher(),
    rate = new LoginRateLimit(30, 60000);
  app = await createApiApplication({
    projects,
    media,
    objects,
    uploadSessions: repository,
    clock,
    ids: new NodeProjectIdGenerator(),
    mediaIds: new NodeMediaAssetIdGenerator(),
    presignTtlSeconds: 900,
    publication,
    auth: {
      currentUser: new GetCurrentUser(users),
      register: new RegisterUser(users, refreshSessions, passwords, tokens, clock, rate),
      login: new LoginUser(users, refreshSessions, passwords, tokens, clock, rate),
      refresh: new RefreshAccess(users, refreshSessions, tokens, clock),
      logout: new LogoutUser(refreshSessions, clock),
      tokens,
      now: () => now,
      cookieSecure: false,
      trustedOrigins: [],
      trustedProxies: [],
    },
  });
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
});
after(async () => {
  try {
    if (pool && objects) {
      const rows = await pool.query<{ storage_key: string; multipart_upload_id: string }>(
        "SELECT storage_key,multipart_upload_id FROM upload_sessions",
      );
      for (const s of rows.rows) {
        keys.add(s.storage_key);
        await objects.abortMultipart(s.storage_key, s.multipart_upload_id);
      }
      for (const key of keys) await objects.delete(key);
      if (queue) {
        const jobs = await pool.query<{ id: string; queue_name: string }>(
          "SELECT id,queue_name FROM jobs",
        );
        for (const job of jobs.rows) await queue.discardQueued(job.id, job.queue_name);
      }
    }
  } finally {
    objects?.close();
    await Promise.all([app?.close(), pool?.end(), queue?.close()]);
  }
});

async function headers(actor = OWNER, csrf = true) {
  const token = await tokens.issueAccess(actor, now);
  return {
    "content-type": "application/json",
    cookie: `editagent_access=${token.token}; editagent_csrf=${"ac".repeat(32)}`,
    ...(csrf ? { "x-editagent-csrf": "ac".repeat(32) } : {}),
  };
}
async function request(path: string, method = "GET", body?: unknown, actor = OWNER, csrf = true) {
  return fetch(base + path, {
    method,
    headers: await headers(actor, csrf),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function put(id: string, n: number, body: Buffer) {
  const signed = await service.signPart(OWNER, PROJECT, id, n);
  const response = await fetch(signed.url, {
    method: "PUT",
    headers: signed.requiredHeaders,
    body,
  });
  assert.equal(response.status, 200, await response.clone().text());
  await service.recordPart(OWNER, PROJECT, id, n, response.headers.get("etag")!);
  return signed;
}

test("real SeaweedFS multipart, non-contiguous durable parts, stale URL refresh, final SHA and idempotency", async () => {
  const blocks = [
    Buffer.alloc(PART_SIZE_BYTES, 1),
    Buffer.alloc(PART_SIZE_BYTES, 2),
    Buffer.alloc(PART_SIZE_BYTES, 3),
    Buffer.from("final actual bytes"),
  ];
  const hash = createHash("sha256");
  for (const block of blocks) hash.update(block);
  const declaration = {
    filename: "multipart.mp4",
    mimeType: "video/mp4",
    byteSize: blocks.reduce((sum, b) => sum + b.length, 0),
    sha256: hash.digest("hex"),
  };
  const { session: s } = await service.start(OWNER, PROJECT, declaration);
  keys.add(s.storageKey);
  for (const n of [1, 2, 4]) await put(s.id, n, blocks[n - 1]!);
  await pool.query("UPDATE upload_sessions SET completed_part_count=99 WHERE id=$1", [s.id]);
  assert.deepEqual(
    (await service.get(OWNER, PROJECT, s.id)).parts.map((p) => p.partNumber),
    [1, 2, 4],
  );
  const reloaded = new MultipartUploads(
    new PostgresProjectRepository(pool),
    new PostgresUploadSessionRepository(pool),
    objects,
    new PostgresMediaAssetRepository(pool),
    new NodeMediaAssetIdGenerator(),
    { now: () => now },
    900,
    publication,
  );
  assert.deepEqual(
    (await reloaded.get(OWNER, PROJECT, s.id)).parts.map((p) => p.partNumber),
    [1, 2, 4],
  );
  await assert.rejects(
    () => service.complete(OWNER, PROJECT, s.id, "req_missing"),
    UploadObjectMismatch,
  );
  await assert.rejects(
    () => service.recordPart(OWNER, PROJECT, s.id, 2, "forged-etag"),
    UploadObjectMismatch,
  );
  await assert.rejects(() =>
    pool.query(
      "UPDATE upload_parts SET etag='different' WHERE upload_session_id=$1 AND part_number=2",
      [s.id],
    ),
  );
  assert.equal(
    (await pool.query("SELECT count(*) FROM inspect_publication_outbox")).rows[0].count,
    "0",
  );
  const shortLived = new MultipartUploads(
    new PostgresProjectRepository(pool),
    new PostgresUploadSessionRepository(pool),
    objects,
    new PostgresMediaAssetRepository(pool),
    new NodeMediaAssetIdGenerator(),
    { now: () => now },
    1,
    publication,
  );
  const old = await shortLived.signPart(OWNER, PROJECT, s.id, 3);
  await new Promise((resolve) => setTimeout(resolve, 2100));
  assert.equal((await fetch(old.url, { method: "PUT", body: blocks[2]! })).status, 403);
  const renewed = await put(s.id, 3, blocks[2]!);
  assert.equal(
    new URL(old.url).searchParams.get("uploadId"),
    new URL(renewed.url).searchParams.get("uploadId"),
  );
  const asset = await service.complete(OWNER, PROJECT, s.id, "req_checksum");
  assert.equal(asset.contentSha256, declaration.sha256);
  const stat = await objects.stat(s.storageKey);
  assert.equal(stat?.checksumSha256Hex, declaration.sha256);
  assert.equal(stat?.byteSize, BigInt(declaration.byteSize));
  assert.equal((await reloaded.complete(OWNER, PROJECT, s.id, "req_replay")).id, asset.id);
  // With two connections, a blocking second advisory-lock waiter used to occupy
  // the connection the first completion needs for MediaAsset lookup. A statement
  // timeout makes that regression fail instead of leaving test resources hung.
  const limitedPool = new Pool({
    connectionString: pool.options.connectionString,
    max: 2,
    options: "-c statement_timeout=1500",
  });
  try {
    const services = Array.from(
      { length: 2 },
      () =>
        new MultipartUploads(
          new PostgresProjectRepository(limitedPool),
          new PostgresUploadSessionRepository(limitedPool),
          objects,
          new PostgresMediaAssetRepository(limitedPool),
          new NodeMediaAssetIdGenerator(),
          { now: () => now },
          900,
        ),
    );
    const concurrent = await Promise.all(
      services.map((limited) => limited.complete(OWNER, PROJECT, s.id, "req_limited")),
    );
    assert.deepEqual(
      concurrent.map((a) => a.id),
      [asset.id, asset.id],
    );
  } finally {
    await limitedPool.end();
  }

  const intents = await pool.query(
    "SELECT job_id,status,correlation_id FROM inspect_publication_outbox WHERE media_asset_id=$1",
    [asset.id],
  );
  assert.equal(intents.rowCount, 1);
  assert.equal(intents.rows[0].status, "Delivered");
  assert.equal(intents.rows[0].correlation_id, "req_checksum");
  const job = await pool.query("SELECT job_type,subject_id FROM jobs WHERE id=$1", [
    intents.rows[0].job_id,
  ]);
  assert.equal(job.rowCount, 1);
  assert.equal(job.rows[0].job_type, "media.inspect");
  assert.equal(job.rows[0].subject_id, asset.id);

  assert.equal(
    (
      await fetch(
        `${process.env["S3_ENDPOINT"] ?? "http://127.0.0.1:9000"}/${process.env["S3_BUCKET"] ?? "editagent"}/${s.storageKey}`,
      )
    ).status,
    403,
  );
  const signed = await objects.presignPart(
    s.storageKey,
    s.multipartUploadId,
    3,
    60,
    PART_SIZE_BYTES,
  );
  const cors = await fetch(signed.url, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:3000",
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(cors.status, 200);
  assert.match(cors.headers.get("access-control-expose-headers") ?? "", /ETag/i);
  await assert.rejects(() =>
    pool.query(
      "INSERT INTO upload_parts(upload_session_id,part_number,etag,byte_size,completed_at) VALUES($1,3,$2,$3,$4)",
      [s.id, "different", PART_SIZE_BYTES, now.toString()],
    ),
  );
  console.info(
    "US-123 SeaweedFS: parts [1,2,4] recovered; missing [3]; final streamed SHA-256 matches real bytes; anonymous GET 403.",
  );
});
test("API authentication, CSRF and session/project/user isolation; authority injection rejected", async () => {
  const declaration = {
    filename: "secure.mp4",
    mimeType: "video/mp4",
    byteSize: 20,
    sha256: sha(Buffer.alloc(20, 8)),
  };
  const route = `/projects/${PROJECT}/uploads/multipart`;
  assert.equal((await request(route, "POST", declaration, OWNER, false)).status, 403);
  assert.equal(
    (
      await fetch(base + route, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `editagent_access=forged; editagent_csrf=${"ac".repeat(32)}`,
          "x-editagent-csrf": "ac".repeat(32),
        },
        body: JSON.stringify(declaration),
      })
    ).status,
    401,
  );
  assert.equal((await request(route, "POST", declaration, VIEWER)).status, 403);
  assert.equal((await request(route, "POST", declaration, STRANGER)).status, 404);
  for (const extra of [
    { storageKey: "arbitrary" },
    { multipartUploadId: "injected" },
    { userId: STRANGER },
    { byteSize: 4294967297 },
    { filename: "../../clip.mp4" },
    { mimeType: "text/plain" },
  ])
    assert.equal((await request(route, "POST", { ...declaration, ...extra })).status, 400);
  const created = await request(route, "POST", declaration);
  assert.equal(created.status, 201);
  const body = (await created.json()) as { uploadSessionId: string };
  const id = body.uploadSessionId;
  assert.equal((await request(`${route}/${id}`, "GET", undefined, EDITOR)).status, 404);
  assert.equal((await request(`/projects/${OTHER}/uploads/multipart/${id}`)).status, 404);
  assert.equal((await request(`${route}/${id}`, "GET", undefined, OWNER, false)).status, 200);
  for (const part of ["0", "-1", "2", "10001"])
    assert.equal((await request(`${route}/${id}/parts/${part}`, "POST")).status, 400);
  assert.equal(
    (await request(`${route}/${id}/parts/1`, "POST", undefined, OWNER, false)).status,
    403,
  );
  assert.equal(
    (await request(`${route}/${id}/complete`, "POST", undefined, OWNER, false)).status,
    403,
  );
  assert.equal((await request(`${route}/${id}`, "DELETE", undefined, OWNER, false)).status, 403);
  assert.equal((await request(`${route}/${id}`, "DELETE")).status, 204);
});
test("wrong byte counts/checksum never record media; abort and expiry remove provider state", async () => {
  const bytes = Buffer.from("checksum bytes");
  const beforeIntents = (await pool.query("SELECT count(*) FROM inspect_publication_outbox"))
    .rows[0].count;
  const bad = await service.start(OWNER, PROJECT, {
    filename: "bad.mp4",
    mimeType: "video/mp4",
    byteSize: bytes.length,
    sha256: "bc".repeat(32),
  });
  keys.add(bad.session.storageKey);
  await put(bad.session.id, 1, bytes);
  await assert.rejects(
    () => service.complete(OWNER, PROJECT, bad.session.id, "req_bad"),
    UploadObjectMismatch,
  );
  assert.equal(
    (
      await pool.query("SELECT count(*) FROM media_assets WHERE storage_key=$1", [
        bad.session.storageKey,
      ])
    ).rows[0].count,
    "0",
  );
  assert.equal(await objects.stat(bad.session.storageKey), null);
  assert.equal(
    (await pool.query("SELECT count(*) FROM inspect_publication_outbox")).rows[0].count,
    beforeIntents,
  );
  const wrong = await service.start(OWNER, PROJECT, {
    filename: "count.mp4",
    mimeType: "video/mp4",
    byteSize: PART_SIZE_BYTES + 1,
    sha256: "bd".repeat(32),
  });
  const signed = await service.signPart(OWNER, PROJECT, wrong.session.id, 1);
  const response = await fetch(signed.url, { method: "PUT", body: Buffer.from("too short") });
  assert.equal(response.status, 403);
  await assert.rejects(
    () => service.recordPart(OWNER, PROJECT, wrong.session.id, 1, "wrong-byte-count"),
    UploadObjectMismatch,
  );
  now = instant(now + UPLOAD_SESSION_TTL_MS + 1n);
  assert.ok((await service.cleanupExpired()) > 0);
  assert.equal(
    (await pool.query("SELECT status FROM upload_sessions WHERE id=$1", [wrong.session.id])).rows[0]
      .status,
    "expired",
  );
  await assert.rejects(() =>
    objects.listParts(wrong.session.storageKey, wrong.session.multipartUploadId),
  );
});

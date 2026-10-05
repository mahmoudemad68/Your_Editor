import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  Project,
  createUuidV7,
  mediaAssetId,
  projectId,
  userId,
  instant,
  PART_SIZE_BYTES,
  uploadPartBytes,
  DomainError,
  UPLOAD_SESSION_TTL_MS,
} from "@editagent/domain";
import { MultipartUploads } from "./multipart-uploads.js";
import { InMemoryUploadSessionRepository } from "./in-memory-upload-sessions.js";
import { InMemoryProjectRepository } from "./in-memory-project-repository.js";
import { InMemoryMediaAssetRepository } from "./in-memory-media-repository.js";
import { MemoryObjectStorage } from "./memory-object-storage.js";
import { ProjectForbiddenError, ProjectNotFoundError } from "./project-access.js";
import {
  UploadObjectMismatch,
  UploadPolicyError,
  ObjectStorageUnavailable,
} from "./upload-errors.js";
const OWNER = userId("018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f"),
  EDITOR = userId("018f6b6e-7c3a-7222-8d3e-9c0b1a2d3e4f"),
  VIEWER = userId("018f6b6e-7c3a-7333-8d3e-9c0b1a2d3e4f"),
  STRANGER = userId("018f6b6e-7c3a-7444-8d3e-9c0b1a2d3e4f");
const PROJECT = projectId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f"),
  OTHER = projectId("018f6b6e-7c3a-7b2b-8d3e-9c0b1a2d3e4f");
const input = {
  filename: "clip.mp4",
  mimeType: "video/mp4",
  byteSize: PART_SIZE_BYTES * 3 + 7,
  sha256: "ab".repeat(32),
};
async function fixture() {
  const projects = new InMemoryProjectRepository(),
    sessions = new InMemoryUploadSessionRepository(),
    objects = new MemoryObjectStorage(),
    media = new InMemoryMediaAssetRepository();
  let now = instant(100n);
  const p = Project.create(PROJECT, "Edit", OWNER, now)
    .grantMembership(OWNER, EDITOR, "editor", now)
    .grantMembership(OWNER, VIEWER, "viewer", now);
  await projects.save(p, null);
  await projects.save(Project.create(OTHER, "Other", OWNER, now), null);
  const service = new MultipartUploads(
    projects,
    sessions,
    objects,
    media,
    { next: () => mediaAssetId(createUuidV7(100, randomBytes(10))) },
    { now: () => now },
    900,
  );
  return {
    service,
    sessions,
    objects,
    media,
    advance: (by: bigint) => {
      now = instant(now + by);
    },
  };
}
function providerPart(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  n: number,
  size = uploadPartBytes(input.byteSize, PART_SIZE_BYTES, n),
  etag = `etag-${n}`,
) {
  const session = f.sessions.sessions.get(id)!;
  f.objects.multipart
    .get(session.multipartUploadId)!
    .parts.set(n, { bytes: new Uint8Array(size), etag });
}
test("multipart ownership, project isolation, immutable recovery and declaration policy", async () => {
  const f = await fixture();
  const start = await f.service.start(OWNER, PROJECT, input);
  const id = start.session.id;
  assert.equal((await f.service.start(OWNER, PROJECT, input)).session.id, id);
  await f.service.start(EDITOR, PROJECT, input);
  await assert.rejects(() => f.service.start(VIEWER, PROJECT, input), ProjectForbiddenError);
  await assert.rejects(() => f.service.start(STRANGER, PROJECT, input), ProjectNotFoundError);
  for (const actor of [EDITOR, STRANGER])
    await assert.rejects(() => f.service.get(actor, PROJECT, id), ProjectNotFoundError);
  await assert.rejects(() => f.service.get(OWNER, OTHER, id), ProjectNotFoundError);
  await assert.rejects(
    () => f.service.start(OWNER, PROJECT, { ...input, mimeType: "video/webm" }),
    UploadObjectMismatch,
  );
  for (const changed of [
    { byteSize: 4294967297 },
    { filename: "../clip.mp4" },
    { filename: "C:\\clip.mp4" },
    { mimeType: "text/plain" },
    { sha256: "tampered" },
  ])
    await assert.rejects(
      () => f.service.start(OWNER, PROJECT, { ...input, ...changed }),
      UploadPolicyError,
    );
});
test("non-contiguous provider parts reconcile; replay is idempotent and incompatible ETags/sizes fail", async () => {
  const f = await fixture();
  const { session: s } = await f.service.start(OWNER, PROJECT, input);
  for (const n of [1, 2, 4]) providerPart(f, s.id, n);
  assert.deepEqual(
    (await f.service.get(OWNER, PROJECT, s.id)).parts.map((p) => p.partNumber),
    [1, 2, 4],
  );
  assert.equal((await f.service.recordPart(OWNER, PROJECT, s.id, 2, "etag-2")).parts.length, 3);
  await assert.rejects(
    () => f.service.recordPart(OWNER, PROJECT, s.id, 2, "wrong-etag"),
    UploadObjectMismatch,
  );
  await assert.rejects(
    () => f.service.complete(OWNER, PROJECT, s.id, "req_test"),
    UploadObjectMismatch,
  );
  const first = await f.service.signPart(OWNER, PROJECT, s.id, 3);
  const refreshed = await f.service.signPart(OWNER, PROJECT, s.id, 3);
  assert.equal(first.url, refreshed.url);
  assert.equal(f.objects.multipart.size, 1);
  for (const n of [0, -1, 5, 1.5, 10001])
    await assert.rejects(() => f.service.signPart(OWNER, PROJECT, s.id, n), DomainError);
  providerPart(f, s.id, 3, 1);
  await assert.rejects(() => f.service.get(OWNER, PROJECT, s.id), UploadObjectMismatch);
  providerPart(f, s.id, 3);
  providerPart(f, s.id, 2, PART_SIZE_BYTES, "changed");
  await assert.rejects(() => f.service.get(OWNER, PROJECT, s.id), UploadObjectMismatch);
});
test("final real bytes SHA-256, serialized idempotent completion and checksum rejection before publication", async () => {
  const f = await fixture();
  const bytes = Buffer.from("real multipart bytes");
  const declaration = {
    ...input,
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const { session: s } = await f.service.start(OWNER, PROJECT, declaration);
  f.objects.multipart.get(s.multipartUploadId)!.parts.set(1, { bytes, etag: "real-etag" });
  const [first, replay] = await Promise.all([
    f.service.complete(OWNER, PROJECT, s.id, "req_1"),
    f.service.complete(OWNER, PROJECT, s.id, "req_2"),
  ]);
  assert.equal(first.id, replay.id);
  assert.equal(first.contentSha256, declaration.sha256);
  assert.equal((await f.media.listByProject(PROJECT)).length, 1);
  await assert.rejects(() => f.service.signPart(OWNER, PROJECT, s.id, 1), UploadObjectMismatch);
  await assert.rejects(() => f.service.abort(OWNER, PROJECT, s.id), UploadObjectMismatch);
  const mismatch = await f.service.start(OWNER, PROJECT, {
    ...declaration,
    sha256: "cd".repeat(32),
  });
  f.objects.multipart.get(mismatch.session.multipartUploadId)!.parts.set(1, { bytes, etag: "bad" });
  await assert.rejects(
    () => f.service.complete(OWNER, PROJECT, mismatch.session.id, "req_bad"),
    UploadObjectMismatch,
  );
  assert.equal((await f.media.listByProject(PROJECT)).length, 1);
  assert.equal(f.sessions.sessions.get(mismatch.session.id)?.status, "failed");
  assert.equal(await f.objects.stat(mismatch.session.storageKey), null);
});
test("provider abort, expiry cleanup and safe storage error mapping", async () => {
  const f = await fixture();
  const { session: s } = await f.service.start(OWNER, PROJECT, input);
  await f.service.abort(OWNER, PROJECT, s.id);
  assert.equal(f.objects.multipart.size, 0);
  await assert.rejects(() => f.service.get(OWNER, PROJECT, s.id), UploadObjectMismatch);
  const expired = await f.service.start(OWNER, PROJECT, input);
  f.advance(UPLOAD_SESSION_TTL_MS + 1n);
  assert.equal(await f.service.cleanupExpired(), 1);
  assert.equal(f.sessions.sessions.get(expired.session.id)?.status, "expired");
  assert.equal(f.objects.multipart.size, 0);
  f.objects.createMultipart = async () => {
    throw new Error("secret storage diagnostic");
  };
  await assert.rejects(
    () => f.service.start(OWNER, PROJECT, { ...input, sha256: "de".repeat(32) }),
    ObjectStorageUnavailable,
  );
});

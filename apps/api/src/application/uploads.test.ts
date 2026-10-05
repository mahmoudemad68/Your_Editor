import assert from "node:assert/strict";
import { test } from "node:test";
import {
  instant,
  type Instant,
  type MediaAssetId,
  mediaAssetId,
  MediaAssetConflict,
  type ProjectId,
  projectId,
  userId,
} from "@editagent/domain";
import { type Clock, type MediaAssetIdGenerator } from "./clock.js";
import { InMemoryMediaAssetRepository } from "./in-memory-media-repository.js";
import { InMemoryProjectRepository } from "./in-memory-project-repository.js";
import { MemoryObjectStorage } from "./memory-object-storage.js";
import { ProjectForbiddenError, ProjectNotFoundError } from "./project-access.js";
import { UploadObjectMismatch, UploadObjectMissing, UploadPolicyError } from "./upload-errors.js";
import { BeginMediaUpload, CompleteMediaUpload } from "./uploads.js";
import { CreateProject, DeleteProject } from "./projects.js";
import { type ProjectIdGenerator } from "./clock.js";

const OWNER = userId("018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f");
const EDITOR = userId("018f6b6e-7c3a-7222-8d3e-9c0b1a2d3e4f");
const VIEWER = userId("018f6b6e-7c3a-7333-8d3e-9c0b1a2d3e4f");
const STRANGER = userId("018f6b6e-7c3a-7444-8d3e-9c0b1a2d3e4f");
const PROJECT = projectId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f");
const OTHER = projectId("018f6b6e-7c3a-7b2b-8d3e-9c0b1a2d3e4f");
const ASSET = mediaAssetId("018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4f");
const HASH = "ab".repeat(32);
const FOUR_GIB = 4n * 1024n * 1024n * 1024n;

class ManualClock implements Clock {
  constructor(private current: Instant) {}
  now(): Instant {
    return this.current;
  }
  set(next: Instant): void {
    this.current = next;
  }
}

class OneProjectId implements ProjectIdGenerator {
  next(): ProjectId {
    return PROJECT;
  }
}

class OneMediaId implements MediaAssetIdGenerator {
  next(): MediaAssetId {
    return ASSET;
  }
}

const declaration = {
  filename: "lecture.mp4",
  mimeType: "video/mp4",
  byteSize: 4,
  sha256: HASH,
};

function setup() {
  const projects = new InMemoryProjectRepository();
  const media = new InMemoryMediaAssetRepository();
  const objects = new MemoryObjectStorage("http://localhost:9000");
  const clock = new ManualClock(instant(10n));
  const createProject = new CreateProject(projects, new OneProjectId(), clock);
  const begin = new BeginMediaUpload(projects, objects, clock, 900);
  const complete = new CompleteMediaUpload(projects, media, objects, new OneMediaId(), clock);
  return { projects, media, objects, clock, createProject, begin, complete };
}

test("BeginMediaUpload allows Owner and Editor and hides everyone else", async () => {
  const { createProject, begin, projects, objects, clock } = setup();
  await createProject.execute(OWNER, "Launch");
  clock.set(instant(20n));
  const created = await projects.findById(PROJECT);
  await projects.save(
    created!.project.grantMembership(OWNER, EDITOR, "editor", instant(20n)),
    created!.revision,
  );
  const edited = await projects.findById(PROJECT);
  await projects.save(
    edited!.project.grantMembership(OWNER, VIEWER, "viewer", instant(20n)),
    edited!.revision,
  );

  const ownerUpload = await begin.execute(OWNER, PROJECT, declaration);
  assert.equal(ownerUpload.storageKey, `projects/${PROJECT}/media/sha256/${HASH}`);
  assert.equal(ownerUpload.uploadUrl.startsWith("http://localhost:9000/"), true);
  assert.equal(ownerUpload.uploadUrl.includes("lecture"), false);
  assert.equal(ownerUpload.uploadUrl.includes(".."), false);
  assert.equal(ownerUpload.requiredHeaders["Content-Type"], "video/mp4");
  assert.equal(ownerUpload.requiredHeaders["If-None-Match"], "*");
  assert.equal(typeof ownerUpload.requiredHeaders["x-amz-checksum-sha256"], "string");
  assert.equal(ownerUpload.expiresAt, 20n + 900n * 1000n);
  const editorUpload = await begin.execute(EDITOR, PROJECT, declaration);
  assert.equal(editorUpload.storageKey, ownerUpload.storageKey);

  await assert.rejects(() => begin.execute(VIEWER, PROJECT, declaration), ProjectForbiddenError);
  await assert.rejects(() => begin.execute(STRANGER, PROJECT, declaration), ProjectNotFoundError);
  await assert.rejects(() => begin.execute(OWNER, OTHER, declaration), ProjectNotFoundError);

  clock.set(instant(30n));
  await new DeleteProject(projects, clock).execute(OWNER, PROJECT);
  await assert.rejects(() => begin.execute(OWNER, PROJECT, declaration), ProjectNotFoundError);
  assert.equal(objects.objects.size, 0);
});

test("BeginMediaUpload rejects MIME, size, hash, and hostile filenames before a URL exists", async () => {
  const { createProject, begin, objects } = setup();
  await createProject.execute(OWNER, "Launch");
  const hostile = "../../etc/passwd";
  const begun = await begin.execute(OWNER, PROJECT, { ...declaration, filename: hostile });
  assert.equal(begun.storageKey.includes(".."), false);
  assert.equal(begun.storageKey.includes("etc"), false);
  assert.equal(begun.storageKey.includes("passwd"), false);
  assert.equal(objects.objects.size, 0);

  await assert.rejects(
    () => begin.execute(OWNER, PROJECT, { ...declaration, mimeType: "video/x-msvideo" }),
    UploadPolicyError,
  );
  await assert.rejects(
    () =>
      begin.execute(OWNER, PROJECT, {
        ...declaration,
        filename: "clip.mp4",
        mimeType: "application/octet-stream",
      }),
    UploadPolicyError,
  );
  await assert.rejects(
    () => begin.execute(OWNER, PROJECT, { ...declaration, byteSize: FOUR_GIB + 1n }),
    UploadPolicyError,
  );
  await begin.execute(OWNER, PROJECT, { ...declaration, byteSize: FOUR_GIB });
  await assert.rejects(
    () => begin.execute(OWNER, PROJECT, { ...declaration, byteSize: 0 }),
    UploadPolicyError,
  );
  await assert.rejects(
    () => begin.execute(OWNER, PROJECT, { ...declaration, sha256: "AB".repeat(32) }),
    UploadPolicyError,
  );
  await assert.rejects(
    () => begin.execute(OWNER, PROJECT, { ...declaration, filename: "bad\u0000name.mp4" }),
    UploadPolicyError,
  );
  assert.equal(objects.objects.size, 0);
});

test("CompleteMediaUpload publishes one inspect job for the request correlation id", async () => {
  const projects = new InMemoryProjectRepository();
  const objects = new MemoryObjectStorage("http://localhost:9000");
  const clock = new ManualClock(instant(10n));
  await new CreateProject(projects, new OneProjectId(), clock).execute(OWNER, "Launch");
  const key = `projects/${PROJECT}/media/sha256/${HASH}`;
  await objects.put(key, new Uint8Array(4), "video/mp4", HASH);
  const published: Array<{ mediaAssetId: string; correlationId: string }> = [];
  let stored: Awaited<ReturnType<InMemoryMediaAssetRepository["findById"]>> = null;
  const complete = new CompleteMediaUpload(
    projects,
    new InMemoryMediaAssetRepository(),
    objects,
    new OneMediaId(),
    clock,
    {
      async complete(asset, correlationId) {
        if (
          stored !== null &&
          stored.storageKey === asset.storageKey &&
          stored.displayFilename === asset.displayFilename
        ) {
          return stored;
        }
        stored = asset;
        published.push({ mediaAssetId: asset.id, correlationId });
        return asset;
      },
    },
  );
  const asset = await complete.execute(OWNER, PROJECT, declaration, "web-request-1");
  const repeated = await complete.execute(OWNER, PROJECT, declaration, "web-request-2");
  assert.equal(repeated.id, asset.id);
  assert.deepEqual(published, [{ mediaAssetId: asset.id, correlationId: "web-request-1" }]);
});

test("CompleteMediaUpload persists a verified object and rejects mismatches", async () => {
  const { createProject, complete, objects, media } = setup();
  await createProject.execute(OWNER, "Launch");
  const key = `projects/${PROJECT}/media/sha256/${HASH}`;
  await objects.put(key, new Uint8Array(4), "video/mp4", HASH);
  const asset = await complete.execute(OWNER, PROJECT, {
    ...declaration,
    filename: "..\\..\\windows\\system32\\evil.mp4",
  });
  assert.equal(asset.id, ASSET);
  assert.equal(asset.projectId, PROJECT);
  assert.equal(asset.displayFilename, "..\\..\\windows\\system32\\evil.mp4");
  assert.equal(asset.storageKey, key);
  assert.equal(asset.duration, null);
  assert.equal((await media.findById(ASSET))?.contentSha256, HASH);

  await assert.rejects(() => complete.execute(OWNER, PROJECT, declaration), MediaAssetConflict);

  await objects.put(key + "-other", new Uint8Array(4), "video/mp4", "cd".repeat(32));
  await assert.rejects(
    () =>
      complete.execute(OWNER, PROJECT, {
        ...declaration,
        sha256: "cd".repeat(32),
        filename: "missing.mp4",
      }),
    UploadObjectMissing,
  );

  const mismatchHash = "ef".repeat(32);
  const mismatchKey = `projects/${PROJECT}/media/sha256/${mismatchHash}`;
  await objects.put(mismatchKey, new Uint8Array(3), "video/webm", mismatchHash);
  await assert.rejects(
    () =>
      complete.execute(OWNER, PROJECT, {
        ...declaration,
        sha256: mismatchHash,
        mimeType: "video/mp4",
        byteSize: 4,
        filename: "bad.mp4",
      }),
    UploadObjectMismatch,
  );
  assert.equal(objects.objects.has(mismatchKey), true);
  assert.equal(objects.objects.get(mismatchKey)?.contentType, "video/webm");
  assert.equal((await media.listByProject(PROJECT)).length, 1);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Project,
  instant,
  projectId,
  userId,
  type JobStatus,
  type IObjectStorage,
} from "@editagent/domain";
import { TimelineExports, type TimelineRenderJobs } from "./timeline-exports.js";
import { TimelineConflict, TimelineEditor } from "./timeline-editor.js";
import { InMemoryProjectRepository } from "./in-memory-project-repository.js";
import { InMemoryMediaAssetRepository } from "./in-memory-media-repository.js";
import { GetMediaDetails } from "./media-details.js";
import { MemoryObjectStorage } from "./memory-object-storage.js";
import { ProjectForbiddenError, ProjectNotFoundError } from "./project-access.js";

const id = (n: number) => `018f6b6e-7c3a-7000-8000-${String(n).padStart(12, "0")}`;
const OWNER = userId(id(1)),
  VIEWER = userId(id(2)),
  STRANGER = userId(id(3)),
  PROJECT = projectId(id(4));
async function fixture(status: JobStatus = "Completed") {
  const projects = new InMemoryProjectRepository();
  await projects.save(
    Project.create(PROJECT, "Export", OWNER, instant(1n)).grantMembership(
      OWNER,
      VIEWER,
      "viewer",
      instant(2n),
    ),
    null,
  );
  const editor = new TimelineEditor(
    projects,
    new GetMediaDetails(projects, new InMemoryMediaAssetRepository()),
    {
      async load() {
        throw new Error("Not loaded in download tests");
      },
      async save() {
        throw new Error("Not mutated in download tests");
      },
    },
    {
      async propose() {
        throw new Error("Not proposed in download tests");
      },
    },
    { now: () => instant(3n) },
    () => id(5),
  );
  let signs = 0,
    cancelled = 0;
  const jobs: TimelineRenderJobs = {
    async enqueue() {
      throw new Error("Not enqueued in download tests");
    },
    async read(project, job) {
      return project === PROJECT && job === id(6)
        ? {
            job: { jobId: id(6), status, attempt: 1, updatedAt: "3" },
            outputKey: status === "Completed" ? "server-owned-key" : null,
          }
        : null;
    },
    async cancel() {
      cancelled++;
    },
  };
  const objects: IObjectStorage = new MemoryObjectStorage();
  objects.presignGet = async (key, ttl) => {
    assert.equal(key, "server-owned-key");
    assert.equal(ttl, 60);
    signs++;
    return { url: "https://storage.test/preview" };
  };
  let afterSign = async () => {};
  const exports = new TimelineExports(projects, editor, jobs, objects, async (key, ttl) => {
    assert.equal(key, "server-owned-key");
    assert.equal(ttl, 60);
    signs++;
    await afterSign();
    return { url: "https://storage.test/download" };
  });
  return {
    exports,
    projects,
    editor,
    jobs,
    signs: () => signs,
    cancelled: () => cancelled,
    afterSign: (callback: () => Promise<void>) => {
      afterSign = callback;
    },
  };
}
test("only an authorized member can sign a completed export; internal keys stay private", async () => {
  const f = await fixture();
  const data = await f.exports.download(VIEWER, PROJECT, id(6));
  assert.deepEqual(data, {
    previewUrl: "https://storage.test/preview",
    downloadUrl: "https://storage.test/download",
    expiresInSeconds: 60,
  });
  assert.equal(f.signs(), 2);
  assert.equal("outputKey" in (await f.exports.read(OWNER, PROJECT, id(6))), false);
  await assert.rejects(f.exports.download(STRANGER, PROJECT, id(6)), ProjectNotFoundError);
  await assert.rejects(f.exports.download(OWNER, PROJECT, id(7)), ProjectNotFoundError);
  assert.equal(f.signs(), 2);
});
test("incomplete and cancelled renders cannot produce export links", async () => {
  for (const status of ["Queued", "Running", "Retrying", "Failed", "Cancelled"] as const) {
    const f = await fixture(status);
    await assert.rejects(f.exports.download(OWNER, PROJECT, id(6)), TimelineConflict);
    assert.equal(f.signs(), 0);
  }
});
test("membership revocation during signing prevents the links from being returned", async () => {
  const f = await fixture();
  f.afterSign(async () => {
    const loaded = (await f.projects.findById(PROJECT))!;
    await f.projects.save(
      loaded.project.revokeMembership(OWNER, VIEWER, instant(4n)),
      loaded.revision,
    );
  });
  await assert.rejects(f.exports.download(VIEWER, PROJECT, id(6)), ProjectNotFoundError);
});
test("viewers cannot cancel and unrelated render identities are not discoverable", async () => {
  const f = await fixture("Running");
  await assert.rejects(f.exports.cancel(VIEWER, PROJECT, id(6)), ProjectForbiddenError);
  await assert.rejects(f.exports.cancel(OWNER, PROJECT, id(7)), ProjectNotFoundError);
  assert.equal(f.cancelled(), 0);
  await f.exports.cancel(OWNER, PROJECT, id(6));
  assert.equal(f.cancelled(), 1);
});

test("validation receipts require current membership, matching job, completion and a closed public schema", async () => {
  const f = await fixture(),
    read = f.jobs.read.bind(f.jobs);
  const proof = {
    schemaVersion: "1.0.0",
    jobId: id(6),
    artifactSha256: "a".repeat(64),
    inputSha256: "b".repeat(64),
    timelineSha256: "c".repeat(64),
    renderVersion: "d".repeat(64),
    durationUs: "2000000",
    videoFrames: 50,
    audioPresent: true,
    videoCodec: "h264",
    audioCodec: "aac",
    width: 320,
    height: 180,
    frameRate: { numerator: "25", denominator: "1" },
    validation: "render_worker_ffprobe_v1",
  };
  let validation: unknown = proof;
  f.jobs.read = async (project, job) => {
    const row = await read(project, job);
    return row ? { ...row, validation } : null;
  };
  assert.deepEqual(await f.exports.validation(VIEWER, PROJECT, id(6)), proof);
  await assert.rejects(f.exports.validation(STRANGER, PROJECT, id(6)), ProjectNotFoundError);
  for (const bad of [
    null,
    { ...proof, jobId: id(7) },
    { ...proof, privateStorageKey: "private" },
  ]) {
    validation = bad;
    await assert.rejects(f.exports.validation(OWNER, PROJECT, id(6)), TimelineConflict);
  }
  f.jobs.read = async (project, job) => {
    const row = await read(project, job),
      loaded = (await f.projects.findById(PROJECT))!;
    await f.projects.save(
      loaded.project.revokeMembership(OWNER, VIEWER, instant(4n)),
      loaded.revision,
    );
    return row ? { ...row, validation: proof } : null;
  };
  await assert.rejects(f.exports.validation(VIEWER, PROJECT, id(6)), ProjectNotFoundError);
  assert.equal(f.signs(), 0);
});

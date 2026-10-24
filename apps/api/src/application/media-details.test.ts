import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DomainError,
  instant,
  MediaAsset,
  mediaAssetId,
  Project,
  projectId,
  userId,
} from "@editagent/domain";
import { InMemoryMediaAssetRepository } from "./in-memory-media-repository.js";
import { GetMediaDetails } from "./media-details.js";
import { InMemoryProjectRepository } from "./in-memory-project-repository.js";
import { ProjectNotFoundError } from "./project-access.js";
import { GetMediaAnalysis } from "./media-analysis.js";
import type { AnalysisDocument } from "@editagent/analysis-core";

const NOW = instant(1_700_000_000_000n);
const OWNER = userId("018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f");
const EDITOR = userId("018f6b6e-7c3a-7222-8d3e-9c0b1a2d3e4f");
const VIEWER = userId("018f6b6e-7c3a-7333-8d3e-9c0b1a2d3e4f");
const STRANGER = userId("018f6b6e-7c3a-7444-8d3e-9c0b1a2d3e4f");
const PROJECT = projectId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f");
const OTHER = projectId("018f6b6e-7c3a-7b2b-8d3e-9c0b1a2d3e4f");
const ASSET = mediaAssetId("018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4f");
const OTHER_ASSET = mediaAssetId("018f6b6e-7c3a-7b2d-8d3e-9c0b1a2d3e4f");

async function fixture(): Promise<{
  details: GetMediaDetails;
  media: InMemoryMediaAssetRepository;
}> {
  const projects = new InMemoryProjectRepository();
  const media = new InMemoryMediaAssetRepository();
  const project = Project.create(PROJECT, "Launch", OWNER, NOW)
    .grantMembership(OWNER, EDITOR, "editor", instant(1_700_000_000_010n))
    .grantMembership(OWNER, VIEWER, "viewer", instant(1_700_000_000_020n));
  await projects.save(project, null);
  await projects.save(Project.create(OTHER, "Other", STRANGER, NOW), null);
  await media.save(
    MediaAsset.createUploaded({
      id: ASSET,
      projectId: PROJECT,
      createdAt: NOW,
      displayFilename: "lecture.mp4",
      mimeType: "video/mp4",
      byteSize: 32,
      contentSha256: "ab".repeat(32),
    }),
  );
  await media.save(
    MediaAsset.createUploaded({
      id: OTHER_ASSET,
      projectId: OTHER,
      createdAt: NOW,
      displayFilename: "other.mp4",
      mimeType: "video/mp4",
      byteSize: 32,
      contentSha256: "cd".repeat(32),
    }),
  );
  return { details: new GetMediaDetails(projects, media), media };
}

test("owner, editor, and viewer can read media details", async () => {
  const { details } = await fixture();
  for (const actor of [OWNER, EDITOR, VIEWER]) {
    const asset = await details.execute(actor, PROJECT, ASSET);
    assert.equal(asset.id, ASSET);
    assert.equal(asset.inspectionStatus, "pending");
    assert.equal(asset.duration, null);
  }
});

test("a soft-deleted project does not reveal its media", async () => {
  const projects = new InMemoryProjectRepository();
  const media = new InMemoryMediaAssetRepository();
  const project = Project.create(PROJECT, "Launch", OWNER, NOW).grantMembership(
    OWNER,
    VIEWER,
    "viewer",
    instant(1_700_000_000_020n),
  );
  await projects.save(project, null);
  await media.save(
    MediaAsset.createUploaded({
      id: ASSET,
      projectId: PROJECT,
      createdAt: NOW,
      displayFilename: "lecture.mp4",
      mimeType: "video/mp4",
      byteSize: 32,
      contentSha256: "ab".repeat(32),
    }),
  );
  const loaded = await projects.findById(PROJECT);
  assert.ok(loaded);
  await projects.save(
    loaded.project.deleteProject(OWNER, instant(1_700_000_000_030n)),
    loaded.revision,
  );
  const details = new GetMediaDetails(projects, media);
  await assert.rejects(() => details.execute(OWNER, PROJECT, ASSET), ProjectNotFoundError);
  await assert.rejects(() => details.execute(VIEWER, PROJECT, ASSET), ProjectNotFoundError);
});

test("non-members, unknown projects, and foreign assets are not found", async () => {
  const { details } = await fixture();
  await assert.rejects(() => details.execute(STRANGER, PROJECT, ASSET), ProjectNotFoundError);
  await assert.rejects(
    () => details.execute(OWNER, projectId("018f6b6e-7c3a-7b2e-8d3e-9c0b1a2d3e4f"), ASSET),
    ProjectNotFoundError,
  );
  await assert.rejects(() => details.execute(OWNER, PROJECT, OTHER_ASSET), ProjectNotFoundError);
  await assert.rejects(() => details.execute(OWNER, OTHER, OTHER_ASSET), ProjectNotFoundError);
});

test("inconsistent membership snapshots are opaque on private media reads", async () => {
  const projects = new InMemoryProjectRepository();
  projects.findById = async () => {
    throw new DomainError("private account membership rows");
  };
  const details = new GetMediaDetails(projects, new InMemoryMediaAssetRepository());
  for (const actor of [OWNER, STRANGER])
    await assert.rejects(
      details.execute(actor, PROJECT, ASSET),
      (error) => error instanceof ProjectNotFoundError && !error.message.includes("private"),
    );
});

test("failure details reauthorize after the durable companion read", async () => {
  const { details, media } = await fixture();
  const original = details.execute.bind(details);
  let authorizationReads = 0,
    companionRead = false;
  details.execute = async (...args) => {
    if (++authorizationReads === 3) throw new ProjectNotFoundError();
    return original(...args);
  };
  const absent = { status: "not_available" } as const;
  const document: AnalysisDocument = {
    schemaVersion: "1.1.0",
    mediaAssetId: ASSET,
    source: { sha256: "ab".repeat(32) },
    provenance: { producer: "unit", producerVersion: "1" },
    sections: {
      metadata: absent,
      transcript: absent,
      audio: absent,
      scenes: absent,
      faces: absent,
      objects: absent,
    },
  };
  const getter = new GetMediaAnalysis(
    details,
    {
      read: async () => document,
      failureDetails: async () => {
        companionRead = true;
        return { mediaAssetId: ASSET, sourceSha256: document.source.sha256, failures: [] };
      },
    },
    media,
  );
  await assert.rejects(getter.failures(OWNER, PROJECT, ASSET), ProjectNotFoundError);
  assert.equal(companionRead, true);
  assert.equal(authorizationReads, 3);
});

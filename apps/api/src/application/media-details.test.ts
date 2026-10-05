import assert from "node:assert/strict";
import { test } from "node:test";
import { instant, MediaAsset, mediaAssetId, Project, projectId, userId } from "@editagent/domain";
import { InMemoryMediaAssetRepository } from "./in-memory-media-repository.js";
import { GetMediaDetails } from "./media-details.js";
import { InMemoryProjectRepository } from "./in-memory-project-repository.js";
import { ProjectNotFoundError } from "./project-access.js";

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

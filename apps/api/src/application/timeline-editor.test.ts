import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  MediaAsset,
  DomainError,
  applyCommand,
  Project,
  SplitClip,
  Timeline,
  TrimClip,
  frameRate,
  instant,
  mediaAssetId,
  projectId,
  userId,
} from "@editagent/domain";
import { InMemoryProjectRepository } from "./in-memory-project-repository.js";
import { InMemoryMediaAssetRepository } from "./in-memory-media-repository.js";
import { GetMediaDetails } from "./media-details.js";
import {
  TimelineConflict,
  TimelineEditor,
  type TimelineStore,
  type StoredTimeline,
  type TimelineProposals,
} from "./timeline-editor.js";
import { ProjectForbiddenError, ProjectNotFoundError } from "./project-access.js";

const id = (n: number) => `018f6b6e-7c3a-7000-8000-${String(n).padStart(12, "0")}`;
const OWNER = userId(id(1)),
  VIEWER = userId(id(2)),
  STRANGER = userId(id(3));
const PROJECT = projectId(id(4)),
  MEDIA = mediaAssetId(id(5));
const NOW = instant(1000n);
const hash = (t: Timeline) =>
  createHash("sha256").update(JSON.stringify(t.toSnapshot())).digest("hex");

async function fixture(inspected = true) {
  const projects = new InMemoryProjectRepository(),
    media = new InMemoryMediaAssetRepository();
  await projects.save(
    Project.create(PROJECT, "Demo", OWNER, NOW).grantMembership(OWNER, VIEWER, "viewer", NOW),
    null,
  );
  const uploaded = MediaAsset.createUploaded({
    id: MEDIA,
    projectId: PROJECT,
    createdAt: NOW,
    displayFilename: "demo.mp4",
    mimeType: "video/mp4",
    byteSize: 100,
    contentSha256: "a".repeat(64),
  });
  const validated = uploaded
    .recordInspection(
      {
        container: "mp4",
        videoCodec: "h264",
        audioCodec: "aac",
        width: 640,
        height: 360,
        displayWidth: 640,
        displayHeight: 360,
        rotation: 0,
        frameRate: frameRate(30n, 1n),
        frameRateMode: "constant",
        duration: 2_010_000n,
        colorSpace: null,
        audioChannels: 2,
        sampleRate: 48000,
        streams: [
          {
            codecType: "video",
            codecName: "h264",
            width: 640,
            height: 360,
            sampleRate: null,
            channels: null,
          },
        ],
      },
      NOW,
    )
    .recordValidation("b".repeat(64), null, NOW);
  await media.save(inspected ? validated : uploaded);
  let stored: StoredTimeline | null = null,
    writes = 0,
    ids = 10;
  const store: TimelineStore = {
    async load(project, timeline) {
      if (!stored || stored.timeline.projectId !== project || stored.timeline.id !== timeline)
        throw new ProjectNotFoundError();
      return stored;
    },
    async save(_actor, timeline, expected) {
      if ((stored?.stateSha256 ?? null) !== expected) throw new TimelineConflict();
      stored = { timeline, stateSha256: hash(timeline) };
      writes++;
      return stored.stateSha256;
    },
  };
  const tools: TimelineProposals = {
    async propose(_actor, project, timeline, operation, input) {
      const current = await store.load(project, timeline);
      return {
        basisSha256: current.stateSha256,
        commands: [
          operation === "trim-video"
            ? TrimClip(id(100), timeline, {
                clipId: input.clipId!,
                startUs: input.startUs!,
                endUs: input.endUs!,
              })
            : SplitClip(id(100), timeline, {
                clipId: input.clipId!,
                atUs: input.atUs!,
                rightClipId: id(101),
                rightEffectIds: [],
              }),
        ],
      };
    },
  };
  const editor = new TimelineEditor(
    projects,
    new GetMediaDetails(projects, media),
    store,
    tools,
    { now: () => NOW },
    () => id(ids++),
  );
  return { editor, media, uploaded, store, tools, writes: () => writes };
}

test("validated media creates a persisted canonical timeline on its exact frame grid", async () => {
  const { editor } = await fixture();
  const result = await editor.create(OWNER, PROJECT, MEDIA);
  assert.equal(result.timeline.composition.durationUs, "2000000");
  assert.equal(result.timeline.sources[0]!.durationUs, "2010000");
  assert.equal(result.timeline.tracks[0]!.clips[0]!.outPoint, "2000000");
  assert.deepEqual(await editor.read(VIEWER, PROJECT, result.timeline.id), result);
});

test("viewer cannot mutate; unrelated caller cannot discover a timeline", async () => {
  const { editor, writes } = await fixture();
  const result = await editor.create(OWNER, PROJECT, MEDIA);
  await assert.rejects(editor.create(VIEWER, PROJECT, MEDIA), ProjectForbiddenError);
  await assert.rejects(editor.read(STRANGER, PROJECT, result.timeline.id), ProjectNotFoundError);
  await assert.rejects(
    editor.edit(VIEWER, PROJECT, result.timeline.id, result.stateSha256, "trim-video", {}),
    ProjectForbiddenError,
  );
  assert.equal(writes(), 1);
});

test("uninspected uploads cannot be introduced into an editable timeline", async () => {
  const { editor, writes } = await fixture(false);
  await assert.rejects(editor.create(OWNER, PROJECT, MEDIA), /successful video inspection/);
  assert.equal(writes(), 0);
});

test("trim and split persist canonical commands and reject stale browser edits", async () => {
  const { editor, writes } = await fixture();
  const initial = await editor.create(OWNER, PROJECT, MEDIA);
  const clipId = initial.timeline.tracks[0]!.clips[0]!.id;
  const trimmed = await editor.edit(
    OWNER,
    PROJECT,
    initial.timeline.id,
    initial.stateSha256,
    "trim-video",
    { clipId, startUs: "300000", endUs: "1600000" },
  );
  assert.equal(trimmed.timeline.tracks[0]!.clips[0]!.inPoint, "300000");
  assert.equal(initial.timeline.tracks[0]!.clips[0]!.inPoint, "0");
  await assert.rejects(
    editor.edit(OWNER, PROJECT, initial.timeline.id, initial.stateSha256, "split-video", {
      clipId,
      atUs: "1000000",
    }),
    TimelineConflict,
  );
  const split = await editor.edit(
    OWNER,
    PROJECT,
    initial.timeline.id,
    trimmed.stateSha256,
    "split-video",
    { clipId, atUs: "1000000" },
  );
  assert.equal(split.timeline.tracks[0]!.clips.length, 2);
  assert.equal(writes(), 3);
});

test("a proposal from a newer snapshot cannot overwrite the browser's basis", async () => {
  const { editor, tools, writes } = await fixture();
  const initial = await editor.create(OWNER, PROJECT, MEDIA);
  tools.propose = async () => ({ basisSha256: "c".repeat(64), commands: [] });
  await assert.rejects(
    editor.edit(OWNER, PROJECT, initial.timeline.id, initial.stateSha256, "split-video", {
      clipId: initial.timeline.tracks[0]!.clips[0]!.id,
      atUs: "1000000",
    }),
    TimelineConflict,
  );
  assert.equal(writes(), 1);
});

for (const changed of [false, true]) {
  test(`SDK validation failure keeps ${changed ? "concurrent basis conflict" : "genuine invalid input"} semantics`, async () => {
    const { editor, tools, store, writes } = await fixture();
    const initial = await editor.create(OWNER, PROJECT, MEDIA);
    const clipId = initial.timeline.tracks[0]!.clips[0]!.id;
    tools.propose = async () => {
      if (changed) {
        const next = applyCommand(
          Timeline.restore(initial.timeline),
          TrimClip(id(200), initial.timeline.id, {
            clipId,
            startUs: "300000",
            endUs: "1600000",
          }),
        ).timeline;
        await store.save(OWNER, next, initial.stateSha256);
      }
      throw new DomainError("The bounds are invalid on the SDK's current snapshot.");
    };
    await assert.rejects(
      editor.edit(OWNER, PROJECT, initial.timeline.id, initial.stateSha256, "trim-video", {
        clipId,
        startUs: "200000",
        endUs: "1800000",
      }),
      changed ? TimelineConflict : DomainError,
    );
    const saved = await editor.read(OWNER, PROJECT, initial.timeline.id);
    assert.equal(saved.timeline.tracks[0]!.clips[0]!.inPoint, changed ? "300000" : "0");
    assert.equal(writes(), changed ? 2 : 1);
  });
}
test("a concurrent hash change never conceals an unrelated proposal failure", async () => {
  const { editor, tools, store } = await fixture(),
    initial = await editor.create(OWNER, PROJECT, MEDIA),
    clipId = initial.timeline.tracks[0]!.clips[0]!.id;
  const failure = new Error("unexpected internal failure control");
  tools.propose = async () => {
    const next = applyCommand(
      Timeline.restore(initial.timeline),
      TrimClip(id(201), initial.timeline.id, { clipId, startUs: "300000", endUs: "1600000" }),
    ).timeline;
    await store.save(OWNER, next, initial.stateSha256);
    throw failure;
  };
  await assert.rejects(
    editor.edit(OWNER, PROJECT, initial.timeline.id, initial.stateSha256, "trim-video", {
      clipId,
      startUs: "0",
      endUs: "1800000",
    }),
    (error: unknown) => error === failure,
  );
});

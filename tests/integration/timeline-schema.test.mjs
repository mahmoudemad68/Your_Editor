import test from "node:test";
const { structuredClone } = globalThis;
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  Timeline,
  Track,
  Clip,
  Project,
  projectId,
  userId,
  createUuidV7,
  frameRate,
  serializeProject,
  deserializeProject,
  AddTimedCaption,
  CommandBus,
  DEFAULT_CAPTION_STYLE,
  segmentCaptionWords,
  applyCommand,
  parseCommand,
} from "../../packages/domain/dist/index.js";
const require = createRequire(new URL("../../packages/job-queue/package.json", import.meta.url));
const Ajv = require("ajv/dist/2020.js");
const schema = JSON.parse(
  readFileSync(new URL("../../packages/schemas/src/project.schema.json", import.meta.url), "utf8"),
);
const validate = new Ajv({ strict: true, allErrors: true, strictRequired: false }).compile(schema);
const id = (n) => createUuidV7(1700000000000 + n, new Uint8Array(10).fill(n));
test("caption project/command/history versions validate separately and retain legacy rejection", () => {
  const load = (name) =>
    JSON.parse(
      readFileSync(new URL(`../../packages/schemas/src/${name}`, import.meta.url), "utf8"),
    );
  const project11 = load("project-v1_1.schema.json"),
    command2 = load("edit-command-v2.schema.json"),
    oldCommands = load("edit-command.schema.json"),
    history11 = load("edit-history-v1_1.schema.json");
  const ajv = new Ajv({ strict: true, allErrors: true, strictRequired: false })
    .addSchema(schema)
    .addSchema(project11)
    .addSchema(oldCommands)
    .addSchema(command2);
  const validProject = ajv.getSchema(project11.$id),
    validCommand = ajv.getSchema(command2.$id),
    validHistory = ajv.compile(history11);
  const project = Project.create(projectId(id(1)), "Caption project", userId(id(2)), 0n);
  const t = new Timeline(id(3), project.id, 0n, {
    composition: { width: 1920, height: 1080, frameRate: frameRate(25n, 1n), durationUs: 8000000n },
    sources: [{ id: id(4), kind: "video", durationUs: "8000000" }],
    tracks: [
      new Track(id(5), id(3), "video", [new Clip(id(6), id(5), 0n, 8000000n, { sourceId: id(4) })]),
    ],
  });
  const words = [
      { text: "Hello", startUs: "1000000", endUs: "1500000", confidence: null },
      { text: "مَرْحَبًا", startUs: "1600000", endUs: "2500000", confidence: 0.8 },
    ],
    rules = { maxCharacters: 32, maxLines: 2, maxCharactersPerSecond: 24, minDurationUs: "500000" };
  const command = AddTimedCaption(id(7), t.id, {
    caption: {
      schemaVersion: "1.0.0",
      id: id(8),
      createdBy: id(2),
      assetId: id(4),
      sourceSha256: "a".repeat(64),
      sourceDurationUs: "8000000",
      evidence: { kind: "human-timed", version: "1.0.0", documentSha256: "b".repeat(64) },
      style: DEFAULT_CAPTION_STYLE,
      rules,
      blocks: segmentCaptionWords(words, "8000000", rules),
    },
  });
  assert.equal(validCommand(command), true, JSON.stringify(validCommand.errors));
  assert.equal(ajv.getSchema(oldCommands.$id)(command), false);
  const bus = new CommandBus(t);
  bus.apply(command);
  const json = JSON.parse(serializeProject(project, bus.timeline));
  assert.equal(json.schemaVersion, "1.1.0");
  assert.equal(validProject(json), true, JSON.stringify(validProject.errors));
  assert.equal(validate(json), false);
  assert.deepEqual(deserializeProject(json).timeline.toSnapshot(), bus.timeline.toSnapshot());
  assert.equal(
    validHistory(JSON.parse(bus.serializeHistory())),
    true,
    JSON.stringify(validHistory.errors),
  );
  assert.equal(validHistory(bus.commandLog()), true, JSON.stringify(validHistory.errors));
  assert.equal(
    validHistory(applyCommand(t, command).inverse),
    true,
    JSON.stringify(validHistory.errors),
  );
  for (const mutate of [
    (c) => (c.payload.caption.style.css = "url(https://example.com)"),
    (c) => (c.schemaVersion = 1),
    (c) => (c.payload.caption.blocks[0].lines[0][0].startUs = "-1"),
  ]) {
    const c = structuredClone(command);
    mutate(c);
    assert.equal(validCommand(c), false);
    assert.throws(() => parseCommand(c));
  }
});
function document(kind = "video") {
  const p = Project.create(projectId(id(1)), "Project", userId(id(2)), 0n);
  const options = {
    kind,
    sourceId: kind === "caption" || kind === "graphics" ? null : id(4),
    text: kind === "caption" ? "مرحباً" : null,
    componentId: kind === "graphics" ? id(9) : null,
  };
  const t = new Timeline(id(3), p.id, 0n, {
    composition: {
      width: 1920,
      height: 1080,
      frameRate: frameRate(30000n, 1001n),
      durationUs: 2000n,
    },
    sources: [{ id: id(4), kind: "video", durationUs: 10000n }],
    tracks: [new Track(id(5), id(3), kind, [new Clip(id(6), id(5), 0n, 1000n, options)])],
  });
  return JSON.parse(serializeProject(p, t));
}
test("project.json schema agrees with all five canonical track variants and domain round-trip", () => {
  for (const kind of ["video", "overlay", "graphics", "caption", "audio"]) {
    const d = document(kind);
    assert.equal(validate(d), true, JSON.stringify(validate.errors));
    assert.deepEqual(JSON.parse(serializeProject(...Object.values(deserializeProject(d)))), d);
  }
});
for (const mutate of [
  (d) => (d.schemaVersion = 2),
  (d) => (d.timeline.tracks[0].kind = "script"),
  (d) => (d.timeline.tracks[0].clips[0].outPoint = 1000),
  (d) => (d.timeline.tracks[0].clips[0].opacity = null),
  (d) => (d.timeline.composition.frameRate.numerator = "0"),
  (d) => (d.project.memberships[0].role = "admin"),
  (d) => (d.timeline.id = "not-a-uuid"),
  (d) => Object.defineProperty(d, "__proto__", { value: { polluted: true }, enumerable: true }),
])
  test("malformed project shape rejects in schema and pure domain", () => {
    const d = document();
    mutate(d);
    assert.equal(validate(d), false);
    assert.throws(() => deserializeProject(d));
  });
test("schema-valid but impossible references/ranges require canonical domain validation", () => {
  for (const mutate of [
    (d) => (d.timeline.tracks[0].clips[0].outPoint = "10001"),
    (d) => (d.timeline.tracks[0].clips[0].sourceId = id(99)),
    (d) => d.timeline.tracks.push(d.timeline.tracks[0]),
  ]) {
    const d = document();
    mutate(d);
    assert.equal(validate(d), true);
    assert.throws(() => deserializeProject(d));
  }
});

for (const transform of [(v) => v.toUpperCase(), (v) => v.replace(/[a-f]/, (c) => c.toUpperCase())])
  test("project schema/parser reject noncanonical identity spelling", () => {
    for (const mutate of [
      (d) => (d.project.id = transform(d.project.id)),
      (d) => (d.project.memberships[0].userId = transform(d.project.memberships[0].userId)),
      (d) => (d.timeline.id = transform(d.timeline.id)),
      (d) => (d.timeline.sources[0].id = transform(d.timeline.sources[0].id)),
      (d) => (d.timeline.tracks[0].id = transform(d.timeline.tracks[0].id)),
      (d) => (d.timeline.tracks[0].clips[0].id = transform(d.timeline.tracks[0].clips[0].id)),
    ]) {
      const d = document();
      mutate(d);
      assert.equal(validate(d), false);
      assert.throws(() => deserializeProject(d));
    }
  });
test("structural schema permits join records; authoritative Track/parser reject conflicting joins", () => {
  const d = document(),
    track = d.timeline.tracks[0];
  track.clips.push({
    ...track.clips[0],
    id: id(7),
    inPoint: "1000",
    outPoint: "2000",
    timelineStartUs: "1000",
  });
  const first = { id: id(10), fromClipId: id(6), toClipId: id(7), kind: "cut", durationUs: "0" };
  track.transitions = [first];
  assert.equal(validate(d), true);
  assert.doesNotThrow(() => deserializeProject(d));
  for (const kind of ["cut", "dissolve"]) {
    track.transitions = [
      first,
      { ...first, id: id(11), kind, durationUs: kind === "cut" ? "0" : "100" },
    ];
    assert.equal(validate(d), true); // Cross-record projected uniqueness is a domain invariant.
    assert.throws(() => deserializeProject(d), /Duplicate/);
  }
});
test("project parser rejects malformed UTF-16 while preserving valid multilingual text exactly", () => {
  for (const text of [
    "\uD800",
    "\uDC00",
    "\uD800x",
    "\uDC00\uD800",
    "hello",
    "مرحبا",
    "😀",
    "Hello مرحبا 🌍",
  ]) {
    const d = document("caption");
    d.timeline.tracks[0].clips[0].text = text;
    assert.equal(validate(d), true); // Domain adds JS UTF-16 validity, beyond structural schema.
    if (!text.isWellFormed()) assert.throws(() => deserializeProject(d), /Unicode/);
    else {
      const restored = deserializeProject(d);
      assert.equal(serializeProject(restored.project, restored.timeline), JSON.stringify(d));
    }
  }
});

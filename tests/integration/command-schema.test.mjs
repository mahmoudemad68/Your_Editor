import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  Timeline,
  Track,
  Clip,
  createUuidV7,
  CommandBus,
  parseCommand,
  parseCommandLog,
  TrimClip,
  SplitClip,
  MoveClip,
  DeleteRange,
  InsertClip,
  SetProperty,
  AddCaption,
  replay,
} from "../../packages/domain/dist/index.js";
const require = createRequire(new URL("../../packages/job-queue/package.json", import.meta.url));
const Ajv = require("ajv/dist/2020.js");
const ajv = new Ajv({ strict: true, strictRequired: false, allErrors: true });
for (const filename of ["project", "edit-command"])
  ajv.addSchema(
    JSON.parse(
      readFileSync(
        new URL(`../../packages/schemas/src/${filename}.schema.json`, import.meta.url),
        "utf8",
      ),
    ),
  );
const validate = ajv.getSchema("https://editagent.local/schemas/edit-command.schema.json");
const id = (n) => createUuidV7(1700000000000 + n, new Uint8Array(10).fill(n));
const t = new Timeline(id(1), id(2), 0n, {
  sources: [{ id: id(3), kind: "video", durationUs: 10000n }],
  composition: {
    width: 1920,
    height: 1080,
    frameRate: { numerator: 30n, denominator: 1n },
    durationUs: 1000n,
  },
  tracks: [
    new Track(id(4), id(1), "video", [new Clip(id(5), id(4), 0n, 1000n, { sourceId: id(3) })]),
    new Track(id(6), id(1), "caption"),
  ],
});
const commands = [
  TrimClip(id(10), t.id, { clipId: id(5), startUs: "1", endUs: "999" }),
  SplitClip(id(11), t.id, { clipId: id(5), atUs: "500", rightClipId: id(20), rightEffectIds: [] }),
  MoveClip(id(12), t.id, { clipId: id(5), trackId: id(4), startUs: "1000" }),
  DeleteRange(id(13), t.id, { startUs: "0", endUs: "1000", fragments: [] }),
  InsertClip(id(14), t.id, {
    clip: new Clip(id(20), id(4), 0n, 1n, { sourceId: id(3), timelineStartUs: 1000n }).toSnapshot(),
  }),
  SetProperty(id(15), t.id, { clipId: id(5), key: "opacity", value: 0.5 }),
  AddCaption(id(16), t.id, {
    captionId: id(20),
    trackId: id(6),
    startUs: "0",
    endUs: "1",
    text: "مرحباً",
  }),
];
test("command schema and domain agree on all seven variants, portable inverses and persisted log/history", () => {
  for (const command of commands) {
    assert.equal(validate(command), true, JSON.stringify(validate.errors));
    assert.deepEqual(parseCommand(command), command);
    const bus = new CommandBus(t);
    bus.apply(command);
    assert.equal(validate(bus.commandLog()), true, JSON.stringify(validate.errors));
    const history = JSON.parse(bus.serializeHistory());
    assert.equal(validate(history), true, JSON.stringify(validate.errors));
    assert.deepEqual(CommandBus.restoreHistory(history).timeline, bus.timeline);
    assert.deepEqual(replay(t, bus.commandLog()), bus.timeline);
  }
});
for (const mutate of [
  (c) => (c.type = "Run"),
  (c) => (c.schemaVersion = 2),
  (c) => (c.id = "bad"),
  (c) => (c.extra = true),
  (c) => (c.payload.key = "constructor.prototype"),
  (c) => (c.payload.value = Infinity),
  (c) => (c.payload.value = -1),
  (c) => Object.defineProperty(c, "__proto__", { value: { polluted: true }, enumerable: true }),
])
  test("malicious command fails schema and domain", () => {
    const c = JSON.parse(JSON.stringify(commands[5]));
    mutate(c);
    assert.equal(validate(c), false);
    assert.throws(() => parseCommand(c));
  });
test("unknown log and history versions fail both contracts", () => {
  const bus = new CommandBus(t);
  for (const value of [
    { ...bus.commandLog(), schemaVersion: 2 },
    { ...JSON.parse(bus.serializeHistory()), schemaVersion: 2 },
  ]) {
    assert.equal(validate(value), false);
    assert.throws(() =>
      value.commands ? parseCommandLog(value) : CommandBus.restoreHistory(value),
    );
  }
});
test("schema-valid impossible references still fail domain replay with index", () => {
  const command = { ...commands[0], payload: { ...commands[0].payload, clipId: id(99) } };
  assert.equal(validate(command), true);
  assert.throws(
    () => replay(t, { schemaVersion: 1, timelineId: t.id, commands: [command] }),
    /command index 0/,
  );
});

for (const text of [
  "",
  " ",
  "\t",
  "\n",
  " \t\n\r ",
  "hello",
  "hello world",
  "مرحبا",
  "مرحبا بالعالم",
  "  hello  ",
  "😀",
  "Hello مرحبا 🌍",
])
  test(`text schema/domain agreement: ${JSON.stringify(text)}`, () => {
    for (const c of [
      { ...commands[5], payload: { clipId: id(20), key: "text", value: text } },
      { ...commands[6], payload: { ...commands[6].payload, text } },
    ]) {
      const valid = Boolean(text.trim());
      assert.equal(validate(c), valid, JSON.stringify(validate.errors));
      if (valid) assert.deepEqual(parseCommand(c), c);
      else assert.throws(() => parseCommand(c));
    }
  });
for (const transform of [(v) => v.toUpperCase(), (v) => v.replace(/[a-f]/, (c) => c.toUpperCase())])
  test("all command identity positions reject noncanonical UUID case in both contracts", () => {
    for (const path of ["id", "timelineId", "clipId", "trackId"]) {
      const c = JSON.parse(JSON.stringify(commands[2]));
      if (path === "id" || path === "timelineId") c[path] = transform(c[path]);
      else c.payload[path] = transform(c.payload[path]);
      assert.equal(validate(c), false);
      assert.throws(() => parseCommand(c));
    }
  });
test("malformed UTF-16 is rejected by the authoritative command domain parser", () => {
  for (const text of ["\uD800", "\uDC00", "\uD800x", "\uDC00\uD800"])
    for (const c of [
      { ...commands[5], payload: { clipId: id(20), key: "text", value: text } },
      { ...commands[6], payload: { ...commands[6].payload, text } },
    ])
      assert.throws(() => parseCommand(c), /Unicode/);
});

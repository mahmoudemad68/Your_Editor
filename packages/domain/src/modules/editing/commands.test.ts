import assert from "node:assert/strict";
import { test } from "vitest";
import fc from "fast-check";
import { createUuidV7 } from "../../kernel/id.js";
import { Timeline, Track, Clip, Caption, Effect, Transition } from "./timeline.js";
import {
  TrimClip,
  SplitClip,
  MoveClip,
  DeleteRange,
  InsertClip,
  SetProperty,
  AddCaption,
  applyCommand,
  applyInverse,
  parseCommand,
  serializeCommand,
  parseCommandLog,
  replay,
  CommandBus,
  type EditCommand,
} from "./commands.js";
const id = (n: number) => createUuidV7(1700000000000 + n, new Uint8Array(10).fill(n % 256));
function initial(): Timeline {
  return new Timeline(id(1), id(2), 0n, {
    composition: {
      width: 1920,
      height: 1080,
      frameRate: { numerator: 30000n, denominator: 1001n },
      durationUs: 10000000n,
    },
    sources: [{ id: id(3), kind: "video", durationUs: 100000000n }],
    tracks: [
      new Track(id(4), id(1), "video", [
        new Clip(id(10), id(4), 0n, 10000000n, {
          sourceId: id(3),
          effects: [new Effect(id(11), id(10))],
        }),
      ]),
      new Track(id(5), id(1), "audio", [
        new Clip(id(12), id(5), 0n, 10000000n, { sourceId: id(3), kind: "audio" }),
      ]),
      new Track(id(6), id(1), "caption", [
        new Caption(id(13), id(6), 0n, 10000000n, "Hello، مرحباً"),
      ]),
      new Track(id(7), id(1), "video"),
    ],
  });
}
const clip = (timeline: Timeline, clipId = id(10)) =>
  timeline
    .toSnapshot()
    .tracks.flatMap((t) => t.clips)
    .find((c) => c.id === clipId)!;
const fragments = [
  { clipId: id(10), rightClipId: id(20), rightEffectIds: [id(21)] },
  { clipId: id(12), rightClipId: id(22), rightEffectIds: [] },
  { clipId: id(13), rightClipId: id(23), rightEffectIds: [] },
];
const examples = [
  TrimClip(id(100), id(1), { clipId: id(10), startUs: "1000000", endUs: "9000000" }),
  SplitClip(id(101), id(1), {
    clipId: id(10),
    atUs: "5000000",
    rightClipId: id(20),
    rightEffectIds: [id(21)],
  }),
  MoveClip(id(102), id(1), { clipId: id(10), trackId: id(7), startUs: "10000000" }),
  DeleteRange(id(103), id(1), { startUs: "3000000", endUs: "6000000", fragments }),
  InsertClip(id(104), id(1), {
    clip: new Clip(id(20), id(4), 20000000n, 30000000n, {
      timelineStartUs: 10000000n,
      sourceId: id(3),
    }).toSnapshot(),
  }),
  SetProperty(id(105), id(1), { clipId: id(10), key: "opacity", value: 0.4 }),
  AddCaption(id(106), id(1), {
    captionId: id(20),
    trackId: id(6),
    startUs: "10000000",
    endUs: "12000000",
    text: "مرحباً بالعالم",
  }),
];
for (const command of examples)
  test(`${command.type}: serialized application, exact inverse, persisted undo/redo`, () => {
    const t = initial(),
      applied = applyCommand(t, serializeCommand(command));
    assert.notDeepEqual(applied.timeline, t);
    assert.deepEqual(
      applyInverse(applied.timeline, JSON.parse(JSON.stringify(applied.inverse))),
      t,
    );
    assert.deepEqual(parseCommand(serializeCommand(command)), command);
    const bus = new CommandBus(t);
    bus.apply(command);
    const restored = CommandBus.restoreHistory(bus.serializeHistory());
    assert.deepEqual(restored.undo(), t);
    assert.deepEqual(restored.redo(), applied.timeline);
    assert.deepEqual(replay(t, JSON.stringify(bus.commandLog())), applied.timeline);
    assert.deepEqual(t, initial());
  });
test("trim maintains exact source offsets and timeline placement; split preserves continuity and IDs", () => {
  const trimmed = applyCommand(initial(), examples[0]).timeline;
  assert.equal(clip(trimmed).inPoint, "1000000");
  assert.equal(clip(trimmed).timelineStartUs, "1000000");
  const split = applyCommand(initial(), examples[1]).timeline;
  assert.equal(clip(split).outPoint, clip(split, id(20)).inPoint);
  assert.equal(clip(split, id(20)).timelineStartUs, "5000000");
  assert.equal(clip(split).effects[0]!.id, id(11));
  assert.equal(clip(split, id(20)).effects[0]!.id, id(21));
});
for (const [start, stop] of [
  [0, 3000000],
  [3000000, 6000000],
  [7000000, 10000000],
  [0, 10000000],
] as const)
  test(`ripple deletion ${start}..${stop} preserves cross-track synchronization`, () => {
    const t = applyCommand(
      initial(),
      DeleteRange(id(100), id(1), {
        startUs: String(start),
        endUs: String(stop),
        fragments: start > 0 && stop < 10000000 ? fragments : [],
      }),
    ).timeline;
    assert.equal(t.composition.durationUs, BigInt(10000000 - stop + start));
    const tracks = t.toSnapshot().tracks.slice(0, 3);
    assert.deepEqual(
      tracks[0]!.clips.map((c) => c.timelineStartUs),
      tracks[1]!.clips.map((c) => c.timelineStartUs),
    );
    assert.deepEqual(
      tracks[0]!.clips.map((c) => c.timelineStartUs),
      tracks[2]!.clips.map((c) => c.timelineStartUs),
    );
    if (start === 0 && stop < 10000000) assert.equal(tracks[0]!.clips[0]!.inPoint, String(stop));
    if (start > 0 && stop < 10000000) assert.equal(tracks[0]!.clips[1]!.inPoint, String(stop));
  });
test("ripple moves later clips, trims edge clips and removes affected transitions", () => {
  const s = initial().toSnapshot();
  s.tracks = [s.tracks[0]!];
  s.tracks[0]!.clips[0]!.outPoint = "5000000";
  s.tracks[0]!.clips.push(
    new Clip(id(20), id(4), 5000000n, 10000000n, {
      sourceId: id(3),
      timelineStartUs: 5000000n,
    }).toSnapshot(),
  );
  s.tracks[0]!.transitions = [
    new Transition(id(30), id(10), id(20), "dissolve", 1000000n).toSnapshot(),
  ];
  const t = Timeline.restore(s);
  const split = applyCommand(
    t,
    SplitClip(id(100), id(1), {
      clipId: id(10),
      atUs: "2000000",
      rightClipId: id(40),
      rightEffectIds: [id(41)],
    }),
  ).timeline;
  assert.equal(split.tracks[0]!.transitions[0]!.fromClipId, id(40));
  const ripple = applyCommand(
    t,
    DeleteRange(id(100), id(1), { startUs: "4000000", endUs: "6000000", fragments: [] }),
  ).timeline;
  assert.equal(ripple.tracks[0]!.transitions.length, 0);
  assert.equal(clip(ripple, id(20)).timelineStartUs, "4000000");
  const after = applyCommand(
    t,
    DeleteRange(id(100), id(1), {
      startUs: "8000000",
      endUs: "9000000",
      fragments: [{ clipId: id(20), rightClipId: id(40), rightEffectIds: [] }],
    }),
  ).timeline;
  assert.equal(after.tracks[0]!.transitions.length, 1);
});
test("caption and audio property edits use explicit whitelisted values", () => {
  assert.equal(
    clip(
      applyCommand(
        initial(),
        SetProperty(id(100), id(1), { clipId: id(13), key: "text", value: "كلمة،" }),
      ).timeline,
      id(13),
    ).text,
    "كلمة،",
  );
  assert.equal(
    clip(
      applyCommand(
        initial(),
        SetProperty(id(100), id(1), { clipId: id(12), key: "volumeDb", value: -12 }),
      ).timeline,
      id(12),
    ).volumeDb,
    -12,
  );
});
const badApplications = [
  { ...examples[0], timelineId: id(999) },
  TrimClip(id(100), id(1), { clipId: id(10), startUs: "0", endUs: "10000001" }),
  TrimClip(id(100), id(1), { clipId: id(999), startUs: "0", endUs: "1" }),
  SplitClip(id(100), id(1), {
    clipId: id(10),
    atUs: "0",
    rightClipId: id(20),
    rightEffectIds: [id(21)],
  }),
  SplitClip(id(100), id(1), {
    clipId: id(10),
    atUs: "10000000",
    rightClipId: id(20),
    rightEffectIds: [id(21)],
  }),
  SplitClip(id(100), id(1), { clipId: id(10), atUs: "1", rightClipId: id(20), rightEffectIds: [] }),
  SplitClip(id(100), id(1), {
    clipId: id(10),
    atUs: "1",
    rightClipId: id(10),
    rightEffectIds: [id(11)],
  }),
  MoveClip(id(100), id(1), { clipId: id(10), trackId: id(999), startUs: "0" }),
  MoveClip(id(100), id(1), { clipId: id(10), trackId: id(6), startUs: "0" }),
  InsertClip(id(100), id(1), {
    clip: new Clip(id(20), id(4), 0n, 1n, { sourceId: id(3) }).toSnapshot(),
  }),
  InsertClip(id(100), id(1), {
    clip: new Clip(id(20), id(999), 0n, 1n, { sourceId: id(3) }).toSnapshot(),
  }),
  AddCaption(id(100), id(1), {
    captionId: id(20),
    trackId: id(999),
    startUs: "0",
    endUs: "1",
    text: "A",
  }),
  AddCaption(id(100), id(1), {
    captionId: id(20),
    trackId: id(4),
    startUs: "0",
    endUs: "1",
    text: "A",
  }),
  SetProperty(id(100), id(1), { clipId: id(10), key: "text", value: "A" }),
  DeleteRange(id(100), id(1), { startUs: "0", endUs: "10000001", fragments: [] }),
  DeleteRange(id(100), id(1), { startUs: "1", endUs: "2", fragments: [] }),
  DeleteRange(id(100), id(1), { startUs: "0", endUs: "1", fragments }),
];
for (const [i, command] of badApplications.entries())
  test(`invalid command ${i} cannot mutate timeline/history/redo`, () => {
    const bus = new CommandBus(initial());
    bus.apply(examples[5]);
    bus.undo();
    const before = bus.serializeHistory(),
      t = bus.timeline;
    assert.throws(() => bus.apply(command));
    assert.equal(bus.serializeHistory(), before);
    assert.equal(bus.timeline, t);
    assert.ok(bus.canRedo);
  });
for (const mutate of [
  (c: Record<string, unknown>) => (c.type = "Execute"),
  (c: Record<string, unknown>) => (c.schemaVersion = 2),
  (c: Record<string, unknown>) => (c.id = "invalid"),
  (c: Record<string, unknown>) => (c.payload = {}),
  (c: Record<string, unknown>) => (c.extra = true),
  (c: Record<string, unknown>) => (c.payload = { clipId: id(10), key: "__proto__", value: "bad" }),
  (c: Record<string, unknown>) => (c.payload = { clipId: id(10), key: "opacity", value: Infinity }),
  (c: Record<string, unknown>) => (c.payload = { clipId: id(10), key: "opacity", value: -1 }),
])
  test("malformed commands reject unsupported data", () => {
    const c = JSON.parse(JSON.stringify(examples[5]));
    mutate(c);
    assert.throws(() => parseCommand(c));
  });
for (const time of [-1, 1.5, NaN, Infinity, "-1", "1.5", "01"])
  test(`invalid command time ${String(time)} fails closed`, () => {
    assert.throws(() =>
      parseCommand({ ...examples[0], payload: { clipId: id(10), startUs: time, endUs: "3" } }),
    );
  });
test("command ranges, payload prototype, inverse identity and schema are strict", () => {
  assert.throws(() => TrimClip(id(100), id(1), { clipId: id(10), startUs: "3", endUs: "3" }));
  assert.throws(() =>
    AddCaption(id(100), id(1), {
      captionId: id(20),
      trackId: id(6),
      startUs: "0",
      endUs: "0",
      text: "A",
    }),
  );
  assert.throws(() => parseCommand({ ...examples[5], payload: Object.create({ clipId: id(10) }) }));
  assert.throws(() => parseCommand(JSON.parse('{"__proto__":{},"type":"SetProperty"}')));
  const applied = applyCommand(initial(), examples[5]),
    inverse = JSON.parse(JSON.stringify(applied.inverse));
  assert.throws(() => applyInverse(initial(), inverse));
  inverse.schemaVersion = 2;
  assert.throws(() => applyInverse(applied.timeline, inverse));
  inverse.schemaVersion = 1;
  inverse.restore.id = id(99);
  inverse.restore.tracks = [];
  assert.throws(() => applyInverse(applied.timeline, inverse));
});
test("bounded history checkpoints evicted commands; empty undo/redo are no-ops", () => {
  const bus = new CommandBus(initial(), 2);
  assert.equal(bus.undo(), bus.timeline);
  assert.equal(bus.redo(), bus.timeline);
  for (let i = 0; i < 3; i++)
    bus.apply(SetProperty(id(100 + i), id(1), { clipId: id(10), key: "opacity", value: i / 3 }));
  assert.equal(bus.history.length, 2);
  assert.equal(clip(Timeline.restore(bus.snapshot())).opacity, 0);
  assert.deepEqual(replay(bus.snapshot(), bus.commandLog()), bus.timeline);
  assert.deepEqual(CommandBus.restoreHistory(bus.serializeHistory()).timeline, bus.timeline);
  bus.undo();
  bus.undo();
  assert.equal(clip(bus.timeline).opacity, 0);
  assert.equal(bus.canUndo, false);
  assert.throws(() => new CommandBus(initial(), 0));
  assert.throws(() => new CommandBus(initial(), 1001));
});
test("command IDs are unique in retained history and new command clears redo", () => {
  const bus = new CommandBus(initial());
  bus.apply(examples[5]);
  const before = bus.serializeHistory();
  assert.throws(() => bus.apply(examples[5]));
  assert.equal(bus.serializeHistory(), before);
  bus.undo();
  bus.apply(examples[0]);
  assert.equal(bus.canRedo, false);
  assert.equal(bus.redo(), bus.timeline);
  assert.ok(Object.isFrozen(bus.history));
  assert.ok(Object.isFrozen(bus.history[0]!.inverse.restore));
});
test("replay rejects malformed, unknown, mismatched and impossible entries with their index", () => {
  const log = { schemaVersion: 1, timelineId: id(1), commands: [examples[5], badApplications[2]] };
  assert.throws(() => replay(initial(), log), /command index 1/);
  assert.throws(
    () => replay(initial(), { ...log, commands: [examples[5], { type: "Secret payload" }] }),
    /command index 1: malformed command/,
  );
  assert.throws(() => parseCommandLog({ ...log, schemaVersion: 2 }));
  assert.throws(() => parseCommandLog({ ...log, commands: [examples[5], examples[5]] }));
  assert.throws(() => parseCommandLog({ ...log, timelineId: id(99) }));
  assert.throws(() => parseCommandLog({ ...log, commands: Array(1001).fill(examples[5]) }));
  assert.throws(() => replay(initial(), { schemaVersion: 1, timelineId: id(99), commands: [] }));
});
test("persisted history validates redo entries, inverses, cursors and bounds before load", () => {
  const bus = new CommandBus(initial());
  bus.apply(examples[5]);
  bus.undo();
  const d = JSON.parse(bus.serializeHistory());
  for (const mutate of [
    (v: typeof d) => (v.schemaVersion = 2),
    (v: typeof d) => (v.cursor = 2),
    (v: typeof d) => (v.maxEntries = 0),
    (v: typeof d) => (v.entries[0].command.type = "Nope"),
    (v: typeof d) => (v.entries[0].inverse.restore.tracks[0].clips[0].opacity = 0.2),
    (v: typeof d) => (v.entries[0].inverse.type = "Run"),
    (v: typeof d) => (v.entries = [v.entries[0], v.entries[0]]),
  ]) {
    const copy = structuredClone(d);
    mutate(copy);
    assert.throws(() => CommandBus.restoreHistory(copy));
  }
  const bounded = { ...d, maxEntries: 1, entries: [d.entries[0], d.entries[0]] };
  assert.throws(() => CommandBus.restoreHistory(bounded));
  const restored = CommandBus.restoreHistory(d);
  assert.deepEqual(restored.timeline, initial());
  assert.deepEqual(restored.redo(), applyCommand(initial(), examples[5]).timeline);
});
// Generate mixed sequences from the current valid graph: all payload identities are explicit,
// source lengths bounded and insert/move/caption operations append without overlap.
function generatedCommand(t: Timeline, kind: number, n: number, amount: number): EditCommand {
  const s = t.toSnapshot(),
    commandId = id(1000 + n * 20),
    newId = id(1001 + n * 20),
    video = s.tracks[0]!,
    c = video.clips[0];
  const total = BigInt(s.composition.durationUs),
    length = c ? BigInt(c.outPoint) - BigInt(c.inPoint) : 0n;
  if (kind === 0 && c)
    return SetProperty(commandId, t.id, { clipId: c.id, key: "opacity", value: amount / 100 });
  if (kind === 1 && c)
    return MoveClip(commandId, t.id, { clipId: c.id, trackId: video.id, startUs: String(total) });
  if (kind === 2 && c && length > 2n)
    return TrimClip(commandId, t.id, {
      clipId: c.id,
      startUs: c.timelineStartUs,
      endUs: String(BigInt(c.timelineStartUs) + length - 1n),
    });
  if (kind === 3 && c && length > 1n)
    return SplitClip(commandId, t.id, {
      clipId: c.id,
      atUs: String(BigInt(c.timelineStartUs) + length / 2n),
      rightClipId: newId,
      rightEffectIds: c.effects.map((_, i) => id(1002 + n * 20 + i)),
    });
  if (kind === 4 && total > 2n) {
    const start = total / 3n,
      stop = start + 1n;
    const fs = s.tracks
      .flatMap((track) =>
        track.clips.filter(
          (v) =>
            BigInt(v.timelineStartUs) < start &&
            BigInt(v.timelineStartUs) + BigInt(v.outPoint) - BigInt(v.inPoint) > stop,
        ),
      )
      .map((v, i) => ({
        clipId: v.id,
        rightClipId: id(1001 + n * 20 + i * 2),
        rightEffectIds: v.effects.map((_, j) => id(1015 + n * 20 + j)),
      }));
    return DeleteRange(commandId, t.id, {
      startUs: String(start),
      endUs: String(stop),
      fragments: fs,
    });
  }
  if (kind === 5)
    return AddCaption(commandId, t.id, {
      captionId: newId,
      trackId: id(6),
      startUs: String(total),
      endUs: String(total + BigInt(amount + 1)),
      text: "Word، كلمة",
    });
  return InsertClip(commandId, t.id, {
    clip: new Clip(newId, video.id, 0n, BigInt(amount + 1), {
      sourceId: id(3),
      timelineStartUs: total,
    }).toSnapshot(),
  });
}
for (const seed of [215214, 215215, 215216])
  test(`generated mixed sequences (seed ${seed}): undo all, replay, redo, invalidation and atomicity`, () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.integer({ min: 0, max: 6 }),
            amount: fc.integer({ min: 0, max: 100 }),
          }),
          { minLength: 1, maxLength: 24 },
        ),
        (steps) => {
          const t = initial(),
            bus = new CommandBus(t);
          const states: Timeline[] = [];
          for (const [n, step] of steps.entries()) {
            states.push(bus.timeline);
            bus.apply(generatedCommand(bus.timeline, step.kind, n, step.amount));
          }
          const final = bus.timeline;
          assert.deepEqual(replay(t, JSON.stringify(bus.commandLog())), final);
          const persisted = CommandBus.restoreHistory(bus.serializeHistory());
          for (let n = steps.length - 1; n >= 0; n--) {
            assert.deepEqual(persisted.undo(), states[n]);
            const before = persisted.serializeHistory();
            assert.throws(() => persisted.apply({ type: "Invalid" }));
            assert.equal(persisted.serializeHistory(), before);
          }
          assert.deepEqual(persisted.timeline, t);
          for (let n = 0; n < steps.length; n++) persisted.redo();
          assert.deepEqual(persisted.timeline, final);
          persisted.undo();
          persisted.apply(generatedCommand(persisted.timeline, 0, 50, 10));
          assert.equal(persisted.canRedo, false);
        },
      ),
      { seed, numRuns: 50 },
    );
  }, 30000);

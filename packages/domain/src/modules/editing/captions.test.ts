import { test } from "vitest";
import assert from "node:assert/strict";
import { frameRate, frameTime } from "../../kernel/time.js";
import { Timeline, Track, Clip } from "./timeline.js";
import {
  AddTimedCaption,
  UpdateCaptionStyle,
  TrimClip,
  SplitClip,
  MoveClip,
  applyCommand,
  CommandBus,
  replay,
} from "./commands.js";
import {
  DEFAULT_CAPTION_STYLE,
  captionStyle,
  captionWords,
  captionTime,
  captionHash,
  captionWordAtFrame,
  segmentCaptionWords,
  restoreCaptionTrack,
  safeCaptionZone,
  projectTimedCaptions,
  validateCaptionReadability,
  CaptionReadabilityError,
  type CaptionTrackV1,
} from "./captions.js";
const id = (n: number) => `018fe277-6ec0-7000-8000-${String(n).padStart(12, "0")}`;
const words = captionWords(
  [
    { text: "Hello", startUs: "1000000", endUs: "1500000", confidence: null },
    { text: "مَرْحَبًا", startUs: "1600000", endUs: "2100000", confidence: 0.7 },
    { text: "بالعالم 👋", startUs: "2200000", endUs: "3000000", confidence: 0.3 },
  ],
  "8000000",
);
const rules = {
  maxCharacters: 32,
  maxLines: 2,
  maxCharactersPerSecond: 24,
  minDurationUs: "500000",
};
function fixture(): Timeline {
  return new Timeline(id(1), id(2), "0", {
    composition: { width: 1920, height: 1080, frameRate: frameRate(25n, 1n), durationUs: 8000000n },
    sources: [{ id: id(3), kind: "video", durationUs: "8000000" }],
    tracks: [
      new Track(id(4), id(1), "video", [
        new Clip(id(5), id(4), "0", "8000000", { sourceId: id(3) }),
      ]),
    ],
  });
}
function caption(): CaptionTrackV1 {
  return restoreCaptionTrack({
    schemaVersion: "1.0.0",
    id: id(6),
    createdBy: id(7),
    assetId: id(3),
    sourceSha256: "a".repeat(64),
    sourceDurationUs: "8000000",
    evidence: { kind: "human-timed", documentSha256: "b".repeat(64), version: "1.0.0" },
    style: DEFAULT_CAPTION_STYLE,
    rules,
    blocks: segmentCaptionWords(words, "8000000", rules),
  });
}
test("source-bound captions are persisted, replayable and undoable without changing old snapshots", () => {
  const t = fixture(),
    old = t.toSnapshot();
  assert.equal("captionsV1" in old, false);
  const bus = new CommandBus(t),
    command = AddTimedCaption(id(8), t.id, { caption: caption() });
  assert.equal(command.schemaVersion, 2);
  bus.apply(command);
  const saved = bus.timeline.toSnapshot();
  assert.deepEqual(Timeline.restore(saved).toSnapshot(), saved);
  assert.deepEqual(replay(t, bus.commandLog()).toSnapshot(), saved);
  assert.deepEqual(bus.undo().toSnapshot(), old);
  assert.deepEqual(bus.redo().toSnapshot(), saved);
  assert.deepEqual(CommandBus.restoreHistory(bus.serializeHistory()).timeline.toSnapshot(), saved);
  const updated = applyCommand(
    bus.timeline,
    UpdateCaptionStyle(id(9), t.id, {
      captionId: id(6),
      style: { ...DEFAULT_CAPTION_STYLE, highlight: "#00ff00" },
    }),
  ).timeline;
  assert.deepEqual(updated.captionsV1[0]!.blocks, bus.timeline.captionsV1[0]!.blocks);
  assert.throws(() => applyCommand(updated, command));
});
test("trim/split projection excludes removed source words and preserves exact native times/confidence", () => {
  let t = applyCommand(fixture(), AddTimedCaption(id(8), id(1), { caption: caption() })).timeline;
  t = applyCommand(
    t,
    TrimClip(id(9), id(1), { clipId: id(5), startUs: "1500000", endUs: "8000000" }),
  ).timeline;
  t = applyCommand(
    t,
    SplitClip(id(10), id(1), {
      clipId: id(5),
      atUs: "4000000",
      rightClipId: id(11),
      rightEffectIds: [],
    }),
  ).timeline;
  const p = projectTimedCaptions(t.toSnapshot());
  assert.equal(p.length, 1);
  assert.deepEqual(p[0]!.lines.flat(), words.slice(1));
  assert.deepEqual(t.captionsV1[0]!.blocks, caption().blocks);
});
test("exact half-open word activation at adjacent frames for 25,30 and rational FPS", () => {
  for (const [n, d, first, until] of [
    [25n, 1n, 25n, 28n],
    [30n, 1n, 30n, 33n],
    [30000n, 1001n, 30n, 33n],
  ]) {
    const literal = [
      { text: "known source interval", startUs: "1000000", endUs: "1100000", confidence: null },
    ];
    const r = frameRate(n!, d!);
    assert.equal(captionWordAtFrame(literal, first! - 1n, r), -1);
    assert.equal(captionWordAtFrame(literal, first!, r), 0);
    assert.equal(captionWordAtFrame(literal, until! - 1n, r), 0);
    assert.equal(captionWordAtFrame(literal, until!, r), -1);
  }
  for (const rate of [frameRate(25n, 1n), frameRate(30n, 1n), frameRate(30000n, 1001n)]) {
    for (const start of [1n, 15n, 29n]) {
      const a = frameTime(start, rate),
        b = frameTime(start + 2n, rate);
      const w = [{ text: "كلمة", startUs: String(a), endUs: String(b), confidence: null }];
      assert.equal(captionWordAtFrame(w, start - 1n, rate), -1);
      assert.equal(captionWordAtFrame(w, start, rate), 0);
      assert.equal(captionWordAtFrame(w, start + 1n, rate), 0);
      assert.equal(captionWordAtFrame(w, start + 2n, rate), -1);
    }
  }
  assert.equal(captionWordAtFrame(words, 39n, frameRate(25n, 1n)), -1);
});
test("source trim plus nonzero composition placement maps exact offsets without changing persisted evidence", () => {
  let t = applyCommand(fixture(), AddTimedCaption(id(8), id(1), { caption: caption() })).timeline;
  t = applyCommand(
    t,
    TrimClip(id(9), id(1), { clipId: id(5), startUs: "1500000", endUs: "8000000" }),
  ).timeline;
  t = applyCommand(
    t,
    MoveClip(id(10), id(1), { clipId: id(5), trackId: id(4), startUs: "4000000" }),
  ).timeline;
  const p = projectTimedCaptions(t.toSnapshot());
  assert.equal(p[0]!.lines.flat()[0]!.startUs, "4100000");
  assert.equal(p[0]!.lines.flat()[0]!.endUs, "4600000");
  assert.equal(p[0]!.lines.flat()[0]!.confidence, 0.7);
  assert.deepEqual(t.captionsV1[0]!.blocks, caption().blocks);
});
test("strict caption times, Unicode, style, line and readability bounds fail closed", () => {
  for (const bad of ["\ud800", "bad\nline", "\u202eforged", "\u0000"])
    assert.throws(() => captionWords([{ ...words[0], text: bad }], "8000000"));
  assert.throws(() => captionWords([{ ...words[0], text: "a" + "\u0301".repeat(32) }], "8000000"));
  for (const change of [
    { startUs: "1500000", endUs: "1500000" },
    { startUs: "-1" },
    { confidence: 2 },
    { confidence: NaN },
  ])
    assert.throws(() => captionWords([{ ...words[0], ...change }], "8000000"));
  assert.throws(() => captionWords([...words].reverse(), "8000000"));
  assert.throws(() =>
    captionStyle({ ...DEFAULT_CAPTION_STYLE, background: "url(https://example.com)" }),
  );
  assert.throws(() => captionStyle({ ...DEFAULT_CAPTION_STYLE, font: "remote" }));
  assert.throws(() => captionTime("1000000\n"));
  assert.throws(() => captionHash("a".repeat(64) + "\n"));
  assert.throws(() => captionStyle({ ...DEFAULT_CAPTION_STYLE, color: "#ffffff\n" }));
  assert.throws(() => captionStyle({ ...DEFAULT_CAPTION_STYLE, highlight: "#ffffff" }));
  assert.throws(() => captionStyle({ ...DEFAULT_CAPTION_STYLE, color: "#000000" }));
  let coerced = false;
  assert.throws(() =>
    captionStyle({
      ...DEFAULT_CAPTION_STYLE,
      direction: {
        toString() {
          coerced = true;
          return "rtl";
        },
      },
    }),
  );
  assert.equal(coerced, false);
  assert.throws(() => captionStyle({ ...DEFAULT_CAPTION_STYLE, css: "color:red" }));
  assert.throws(() =>
    applyCommand(
      fixture(),
      AddTimedCaption(id(8), id(1), {
        caption: { ...caption(), style: { ...DEFAULT_CAPTION_STYLE, preset: "vertical" } },
      }),
    ),
  );
  assert.throws(() =>
    segmentCaptionWords([{ ...words[0]!, text: "X".repeat(200) }], "8000000", rules),
  );
});
test("safe-zone presets are bounded in 9:16,1:1,16:9; 60 minute source admission is finite", () => {
  for (const [w, h, preset] of [
    [1080, 1920, "vertical"],
    [1080, 1080, "square"],
    [1920, 1080, "landscape"],
  ] as const) {
    const z = safeCaptionZone(w, h, { ...DEFAULT_CAPTION_STYLE, preset });
    assert.ok(z.x > 0 && z.y > 0 && z.x + z.width < w && z.y + z.height < h);
  }
  const many = Array.from({ length: 1800 }, (_, i) => ({
    text: i % 2 ? "English" : "عربي",
    startUs: String(i * 2000000),
    endUs: String(i * 2000000 + 500000),
    confidence: null,
  }));
  const validated = captionWords(many, "3600000000");
  const blocks = segmentCaptionWords(validated, "3600000000", rules);
  assert.equal(blocks.flatMap((b) => b.lines.flat()).length, 1800);
  assert.throws(() => captionWords(many, "3600000001"));
});
test("bounded segmentation regroups an unreadable short tail without changing word times or limits", () => {
  const input = captionWords(
    [
      { text: "aaa", startUs: "0", endUs: "400000", confidence: null },
      { text: "bbb", startUs: "500000", endUs: "900000", confidence: 0.8 },
      { text: "ccc", startUs: "1000000", endUs: "1200000", confidence: 0.2 },
    ],
    "1200000",
  );
  const output = segmentCaptionWords(input, "1200000", { ...rules, maxCharacters: 8, maxLines: 1 });
  assert.deepEqual(
    output.flatMap((b) => b.lines.flat()),
    input,
  );
  assert.equal(output.length, 2);
  assert.equal(output[0]!.lines[0]!.length, 1);
  assert.equal(output[1]!.lines[0]!.length, 2);
  assert.ok(output.every((b) => BigInt(b.endUs) - BigInt(b.startUs) >= 500000n));
  assert.deepEqual(
    segmentCaptionWords(input, "1200000", { ...rules, maxCharacters: 8, maxLines: 1 }),
    output,
  );
});

function editedCaptionFixture() {
  const native = captionWords(
    [
      { text: "عربي", startUs: "5800000", endUs: "6200000", confidence: 0.8 },
      { text: "English", startUs: "11800000", endUs: "11950000", confidence: 0.3 },
      { text: "removed", startUs: "13000000", endUs: "13500000", confidence: null },
    ],
    "16000000",
  );
  const t = new Timeline(id(1), id(2), "0", {
    composition: { width: 640, height: 360, frameRate: frameRate(25n, 1n), durationUs: 16000000n },
    sources: [{ id: id(3), kind: "video", durationUs: "16000000" }],
    tracks: [
      new Track(id(4), id(1), "video", [
        new Clip(id(5), id(4), "0", "16000000", { sourceId: id(3) }),
      ]),
    ],
  });
  const source = restoreCaptionTrack({
    ...caption(),
    sourceDurationUs: "16000000",
    style: { ...DEFAULT_CAPTION_STYLE, fontSize: 14 },
    blocks: segmentCaptionWords(native, "16000000", rules),
  });
  const bus = new CommandBus(t);
  bus.apply(AddTimedCaption(id(8), t.id, { caption: source }));
  bus.apply(TrimClip(id(9), t.id, { clipId: id(5), startUs: "0", endUs: "12000000" }));
  bus.apply(
    SplitClip(id(10), t.id, {
      clipId: id(5),
      atUs: "6000000",
      rightClipId: id(11),
      rightEffectIds: [],
    }),
  );
  return { bus, native, source };
}
test("QA93-F1 persisted trim/split/restart projection preserves crossing words and unchanged source evidence", () => {
  const { bus, native, source } = editedCaptionFixture(),
    before = bus.timeline.toSnapshot(),
    bytes = JSON.stringify(before),
    restored = Timeline.restore(JSON.parse(bytes)),
    plan = projectTimedCaptions(restored.toSnapshot());
  assert.deepEqual(
    plan.flatMap((block) => block.lines.flat()),
    native.slice(0, 2),
  );
  assert.deepEqual(restored.captionsV1[0], source);
  assert.deepEqual(CommandBus.restoreHistory(bus.serializeHistory()).timeline.toSnapshot(), before);
  assert.deepEqual(projectTimedCaptions(bus.timeline.toSnapshot()), plan);
  assert.equal(JSON.stringify(before), bytes);
  assert.deepEqual(plan[0]!.sourceClipIds, [id(5), id(11)]);
  assert.equal(plan[1]!.startUs, "11500000");
  assert.equal(plan[1]!.endUs, "12000000");
  assert.equal(plan[1]!.lines[0]![0]!.startUs, "11800000");
  assert.equal(plan[1]!.lines[0]![0]!.endUs, "11950000");
  validateCaptionReadability({ ...source, blocks: plan }, 640, 360);
});
test("non-destructive split is invisible to native caption words and activation frames", () => {
  const { bus } = editedCaptionFixture(),
    split = projectTimedCaptions(bus.timeline.toSnapshot());
  bus.undo();
  const uncut = projectTimedCaptions(bus.timeline.toSnapshot());
  assert.deepEqual(
    split.flatMap((b) => b.lines.flat()),
    uncut.flatMap((b) => b.lines.flat()),
  );
  for (let frame = 140n; frame < 160n; frame++)
    assert.equal(
      captionWordAtFrame(split[0]!.lines.flat(), frame, frameRate(25n, 1n)),
      captionWordAtFrame(uncut[0]!.lines.flat(), frame, frameRate(25n, 1n)),
    );
});
test("source gaps, composition gaps, reverse order and different tracks never bridge native words", () => {
  const { bus } = editedCaptionFixture(),
    snapshot = bus.timeline.toSnapshot();
  for (const mutation of ["source_gap", "timeline_gap", "reverse", "other_track"] as const) {
    const copy = structuredClone(snapshot),
      track = copy.tracks[0]!;
    if (mutation === "source_gap") track.clips[1]!.inPoint = "6240000";
    if (mutation === "timeline_gap") track.clips[1]!.timelineStartUs = "6240000";
    if (mutation === "reverse") {
      track.clips[0]!.timelineStartUs = "6000000";
      track.clips[1]!.timelineStartUs = "0";
    }
    if (mutation === "other_track") {
      const clip = track.clips.pop()!;
      clip.trackId = id(30);
      copy.tracks.push({ ...track, id: id(30), clips: [clip], transitions: [] });
    }
    track.transitions = [];
    const plan = projectTimedCaptions(Timeline.restore(copy).toSnapshot());
    assert.equal(
      plan.flatMap((b) => b.lines.flat()).some((w) => w.text === "عربي"),
      false,
    );
    assert.ok(plan.every((b) => b.sourceClipIds!.length === 1));
  }
});
test("left container padding stays within the retained window and never alters lexical intervals", () => {
  const native = [{ text: "tail", startUs: "11800000", endUs: "11950000", confidence: 0.9 }];
  const blocks = segmentCaptionWords(native, "12000000", rules, "11000000");
  assert.equal(blocks[0]!.startUs, "11500000");
  assert.deepEqual(
    blocks.flatMap((b) => b.lines.flat()),
    native,
  );
  assert.throws(() => segmentCaptionWords(native, "12000000", rules, "11800000"));
  assert.throws(() => segmentCaptionWords(native, "12000000", rules, "11900000"));
  // Ordinary source segmentation stays byte-for-byte stable: left padding is
  // explicitly render-only, never a rewrite of stored analysis/caption evidence.
  assert.throws(() => segmentCaptionWords(native, "12000000", rules));
});
test("repeated source clips keep intentional repetitions while competing tracks still fail closed", () => {
  const { bus } = editedCaptionFixture(),
    repeated = bus.timeline.toSnapshot(),
    track = repeated.tracks[0]!;
  track.transitions = [];
  track.clips[0]!.outPoint = "8000000";
  track.clips[1]!.inPoint = "0";
  track.clips[1]!.outPoint = "8000000";
  track.clips[1]!.timelineStartUs = "8000000";
  const projected = projectTimedCaptions(Timeline.restore(repeated).toSnapshot());
  assert.equal(projected.length, 2);
  assert.equal(projected[0]!.lines[0]![0]!.startUs, "5800000");
  assert.equal(projected[1]!.lines[0]![0]!.startUs, "13800000");
  assert.equal(projected[1]!.lines[0]![0]!.confidence, 0.8);
  const competing = structuredClone(repeated),
    duplicate = structuredClone(competing.tracks[0]!);
  duplicate.id = id(40);
  duplicate.clips = [{ ...duplicate.clips[0]!, id: id(41), trackId: id(40) }];
  competing.tracks.push(duplicate);
  assert.throws(() => projectTimedCaptions(Timeline.restore(competing).toSnapshot()));
});
test("all bounded readability failure reasons remain typed with sanitized messages", () => {
  const base = caption();
  const cases: [CaptionReadabilityError["reason"], (c: CaptionTrackV1) => void][] = [
    [
      "orientation",
      (c) => {
        c.style = { ...c.style, preset: "vertical" };
      },
    ],
    [
      "line_limit",
      (c) => {
        c.rules = { ...c.rules, maxLines: 0 };
      },
    ],
    [
      "character_limit",
      (c) => {
        c.rules = { ...c.rules, maxCharacters: 1 };
      },
    ],
    [
      "width",
      (c) => {
        c.style = { ...c.style, fontSize: 1000 };
      },
    ],
    [
      "height",
      (c) => {
        c.style = { ...c.style, fontSize: 96 };
        c.blocks = [{ ...c.blocks[0]!, lines: [[{ ...words[0]!, text: "a" }]] }];
      },
    ],
    [
      "min_duration",
      (c) => {
        c.blocks[0]!.endUs = String(BigInt(c.blocks[0]!.startUs) + 1n);
      },
    ],
    [
      "reading_speed",
      (c) => {
        c.rules = { ...c.rules, maxCharactersPerSecond: 1 };
      },
    ],
  ];
  for (const [reason, mutate] of cases) {
    const c = structuredClone(base);
    mutate(c);
    assert.throws(
      () => validateCaptionReadability(c, 1920, reason === "height" ? 100 : 1080),
      (error: unknown) => {
        assert.ok(error instanceof CaptionReadabilityError);
        assert.equal(error.reason, reason);
        assert.equal(error.message, "Invalid or unreadable timed captions.");
        return true;
      },
    );
  }
});

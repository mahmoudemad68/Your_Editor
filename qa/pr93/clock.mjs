/** Independent frame clock, projection, bounds, and historical timeline checks.
 * Expected maps are computed here. Product helpers are the subject, not the oracle.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { check, results, writeReport } from "./report.mjs";

const app = process.env.QA_APP_ROOT;
const require = createRequire(path.join(app, "apps/api/package.json"));
const domain = require("@editagent/domain");
const rows = results();
const id = (n) => `018fe277-6ec0-7000-8000-${String(n).padStart(12, "0")}`;

function frameUs(index, numerator, denominator) {
  if (index < 0n) throw new Error("negative frame");
  return (2n * index * 1_000_000n * denominator + numerator) / (2n * numerator);
}
function activeIndex(words, frame, numerator, denominator) {
  const time = frameUs(frame, numerator, denominator);
  return words.findIndex((word) => BigInt(word.startUs) <= time && time < BigInt(word.endUs));
}
function word(text, start, end, confidence = null) {
  return { text, startUs: String(start), endUs: String(end), confidence };
}

await check(
  rows,
  "G1-CLOCK-RATES",
  "Independent rational frame clock matches the product at 25, 30, and 30000/1001",
  () => {
    const samples = [];
    for (const [numerator, denominator] of [
      [25n, 1n],
      [30n, 1n],
      [30000n, 1001n],
    ]) {
      for (const frame of [0n, 1n, 2n, 24n, 30n, 100n]) {
        const expected = frameUs(frame, numerator, denominator);
        const actual = domain.frameTime(frame, { numerator, denominator });
        samples.push({
          frame: String(frame),
          numerator: String(numerator),
          denominator: String(denominator),
          expected: String(expected),
          actual: String(actual),
        });
        if (expected !== actual)
          return { status: "FAIL", expected: "equal clocks", actual: samples.at(-1) };
      }
    }
    return {
      status: "PASS",
      expected: "18 rational samples equal",
      actual: { samples: samples.length },
    };
  },
);

await check(
  rows,
  "G1-HALF-OPEN",
  "Half-open word membership, gaps, adjacent words, and exact end indexes",
  () => {
    const words = [
      word("North", 0, 40_000),
      word("شرق", 80_000, 160_000),
      word("end", 160_000, 200_000),
    ];
    const cases = [
      [0n, 0],
      [1n, -1],
      [2n, 1],
      [3n, 1],
      [4n, 2],
      [5n, -1],
    ];
    const actual = cases.map(([frame, expected]) => ({
      frame: Number(frame),
      expected,
      independent: activeIndex(words, frame, 25n, 1n),
      product: domain.captionWordAtFrame(words, frame, { numerator: 25n, denominator: 1n }),
    }));
    const ok = actual.every(
      (row) => row.expected === row.independent && row.independent === row.product,
    );
    return { status: ok ? "PASS" : "FAIL", expected: "onset/gap/end indexes", actual };
  },
);

await check(
  rows,
  "G1-NEGATIVE-BOUNDS",
  "Negative frames and out-of-order, overlapping, oversized, or bidi-override words are rejected",
  () => {
    let negative = false;
    try {
      domain.captionWordAtFrame([word("A", 0, 10)], -1n, { numerator: 25n, denominator: 1n });
    } catch {
      negative = true;
    }
    const rejects = [
      () => domain.captionWords([word("A", 10, 5)], "1000"),
      () => domain.captionWords([word("B", 0, 10), word("A", 5, 20)], "100"),
      () => domain.captionWords([word("A", 0, 10)], "5"),
      () => domain.captionWords([word("bad\u202e", 0, 10)], "100"),
      () => domain.captionWords([word("a\u0301\u0301\u0301\u0301\u0301", 0, 10)], "100"),
      () => domain.captionTime("3600000001"),
      () => domain.captionTime("-1"),
    ];
    const rejected = rejects.map((fn) => {
      try {
        fn();
        return false;
      } catch {
        return true;
      }
    });
    const sixty = String(domain.captionTime("3600000000")) === "3600000000";
    const ok = negative && rejected.every(Boolean) && sixty;
    return {
      status: ok ? "PASS" : "FAIL",
      expected: "all rejects plus exact 60-minute bound",
      actual: { negative, rejected, sixty },
    };
  },
);

await check(
  rows,
  "G1-PROJECTION",
  "Surviving clips retime source words; clipped and removed words do not reappear",
  () => {
    const rules = {
      maxCharacters: 32,
      maxLines: 2,
      maxCharactersPerSecond: 24,
      minDurationUs: "500000",
    };
    const duration = "8000000";
    const sourceWords = domain.captionWords(
      [
        word("kept", 100_000, 300_000, 0.5),
        word("cut", 1_200_000, 1_400_000, null),
        word("later", 2_100_000, 2_400_000, 0.2),
      ],
      duration,
    );
    const blocks = [
      { startUs: "0", endUs: "500000", lines: [[sourceWords[0]]] },
      { startUs: "1100000", endUs: "1600000", lines: [[sourceWords[1]]] },
      { startUs: "2000000", endUs: "2600000", lines: [[sourceWords[2]]] },
    ];
    const track = domain.restoreCaptionTrack({
      schemaVersion: "1.0.0",
      id: id(6),
      createdBy: id(7),
      assetId: id(3),
      sourceSha256: "a".repeat(64),
      sourceDurationUs: duration,
      evidence: { kind: "human-timed", documentSha256: "b".repeat(64), version: "1.0.0" },
      style: { ...domain.DEFAULT_CAPTION_STYLE, preset: "landscape" },
      rules,
      blocks,
    });
    const clips = [
      {
        id: id(11),
        kind: "video",
        sourceId: id(3),
        inPoint: "0",
        outPoint: "1000000",
        timelineStartUs: "2000000",
      },
      {
        id: id(12),
        kind: "video",
        sourceId: id(3),
        inPoint: "2000000",
        outPoint: "3000000",
        timelineStartUs: "5000000",
      },
    ];
    let projected;
    try {
      projected = domain.projectTimedCaptions({
        captionsV1: [track],
        composition: { width: 640, height: 360 },
        tracks: [{ clips }],
      });
    } catch (error) {
      return {
        status: "FAIL",
        expected: "two surviving words",
        actual: String(error).slice(0, 300),
      };
    }
    const shown = projected.flatMap((block) => block.lines.flat().map((item) => item.text));
    const expected = [
      {
        text: "kept",
        startUs: String(100_000n + 2_000_000n),
        endUs: String(300_000n + 2_000_000n),
      },
      {
        text: "later",
        startUs: String(2_100_000n + 3_000_000n),
        endUs: String(2_400_000n + 3_000_000n),
      },
    ];
    const actual = projected.flatMap((block) =>
      block.lines
        .flat()
        .map((item) => ({ text: item.text, startUs: item.startUs, endUs: item.endUs })),
    );
    const removedAbsent = !shown.includes("cut");
    const same = JSON.stringify(actual) === JSON.stringify(expected);
    return {
      status: removedAbsent && same ? "PASS" : "FAIL",
      expected,
      actual: { actual, removedAbsent, blocks: projected.length },
    };
  },
);

await check(
  rows,
  "G1-SEGMENT-LIMITS",
  "Segmentation keeps whole words inside readability limits and rejects an impossible word",
  () => {
    const rules = {
      maxCharacters: 32,
      maxLines: 2,
      maxCharactersPerSecond: 24,
      minDurationUs: "500000",
    };
    const input = [
      word("Hello", 0, 200_000),
      word("world", 250_000, 400_000),
      word("السَّلَامُ", 1_000_000, 1_400_000),
    ];
    const blocks = domain.segmentCaptionWords(input, "8000000", rules);
    const flat = blocks.flatMap((block) => block.lines.flat());
    const texts = flat.map((item) => item.text);
    const graphemeCount = (value) =>
      [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(value)].length;
    const limits = blocks.every((block) => {
      const span = BigInt(block.endUs) - BigInt(block.startUs);
      const chars = block.lines.reduce(
        (sum, line) => sum + graphemeCount(line.map((item) => item.text.trim()).join(" ")),
        0,
      );
      return (
        span >= 500_000n &&
        span <= 6_000_000n &&
        BigInt(chars) * 1_000_000n <= span * 24n &&
        block.lines.length <= 2
      );
    });
    let impossible = false;
    try {
      domain.segmentCaptionWords([word("x".repeat(40), 0, 200_000)], "8000000", rules);
    } catch {
      impossible = true;
    }
    const ok =
      texts.join("|") === input.map((item) => item.text).join("|") &&
      limits &&
      impossible &&
      flat[1].confidence === null;
    return {
      status: ok ? "PASS" : "FAIL",
      expected: "words preserved, limits held, 40-grapheme word rejected",
      actual: { texts, limits, impossible, blocks: blocks.length },
    };
  },
);

await check(
  rows,
  "G1-CAPACITY",
  "60-minute domain input accepts the bound and rejects 36001 words, 2001 blocks, and 17 tracks",
  () => {
    const many = Array.from({ length: 36001 }, () => word("a", 0, 1));
    const shell = {
      schemaVersion: "1.0.0",
      id: id(6),
      createdBy: id(7),
      assetId: id(3),
      sourceSha256: "a".repeat(64),
      sourceDurationUs: "3600000000",
      evidence: { kind: "human-timed", documentSha256: "b".repeat(64), version: "1.0.0" },
      style: domain.DEFAULT_CAPTION_STYLE,
      rules: {
        maxCharacters: 32,
        maxLines: 2,
        maxCharactersPerSecond: 24,
        minDurationUs: "500000",
      },
      blocks: Array.from({ length: 2001 }, () => ({})),
    };
    const rejected = [
      () => domain.captionWords(many, "3600000000"),
      () => domain.restoreCaptionTrack(shell),
      () => domain.validateCaptionTracks(Array.from({ length: 17 }, () => ({}))),
    ].map((fn) => {
      try {
        fn();
        return false;
      } catch {
        return true;
      }
    });
    return {
      status: rejected.every(Boolean) ? "PASS" : "FAIL",
      expected: "three capacity rejects",
      actual: rejected,
    };
  },
);

await check(
  rows,
  "G1-SAFE-ZONE",
  "Independent safe rectangles match the documented permille presets",
  () => {
    const presets = {
      vertical: { left: 80, right: 180, top: 120, bottom: 220 },
      square: { left: 80, right: 80, top: 80, bottom: 160 },
      landscape: { left: 60, right: 60, top: 80, bottom: 140 },
    };
    function zone(width, height, preset, margin) {
      const item = presets[preset];
      return {
        x: Math.ceil((width * (item.left + margin)) / 1000),
        y: Math.ceil((height * (item.top + margin)) / 1000),
        width: Math.floor((width * (1000 - item.left - item.right - 2 * margin)) / 1000),
        height: Math.floor((height * (1000 - item.top - item.bottom - 2 * margin)) / 1000),
      };
    }
    const cases = [
      [360, 640, "vertical", 0],
      [640, 640, "square", 20],
      [1920, 1080, "landscape", 0],
    ];
    const actual = cases.map(([width, height, preset, margin]) => {
      const style = { ...domain.DEFAULT_CAPTION_STYLE, preset, marginPermille: margin };
      return {
        preset,
        expected: zone(width, height, preset, margin),
        product: domain.safeCaptionZone(width, height, style),
      };
    });
    const ok = actual.every((row) => JSON.stringify(row.expected) === JSON.stringify(row.product));
    return { status: ok ? "PASS" : "FAIL", expected: "three presets", actual };
  },
);

await check(
  rows,
  "G1-HISTORY",
  "A caption-free timeline snapshot still round-trips and does not gain captionsV1",
  () => {
    const timeline = new domain.Timeline(id(1), id(2), "0", {
      composition: {
        width: 640,
        height: 360,
        frameRate: domain.frameRate(25n, 1n),
        durationUs: 2_000_000n,
      },
      sources: [{ id: id(3), kind: "video", durationUs: "2000000" }],
      tracks: [
        new domain.Track(id(4), id(1), "video", [
          new domain.Clip(id(5), id(4), "0", "2000000", { sourceId: id(3) }),
        ]),
      ],
    });
    const snapshot = timeline.toSnapshot();
    const restored = domain.Timeline.restore(snapshot).toSnapshot();
    const ok = !("captionsV1" in snapshot) && JSON.stringify(restored) === JSON.stringify(snapshot);
    return {
      status: ok ? "PASS" : "FAIL",
      expected: "legacy snapshot without captionsV1",
      actual: { hasCaptions: "captionsV1" in snapshot },
    };
  },
);

await check(
  rows,
  "G1-STATIC-DIFF",
  "Static caption rendering in timeline.tsx is unchanged aside from the additive word-caption mount",
  () => {
    const diff = execFileSync(
      "git",
      [
        "-C",
        app,
        "diff",
        "-U0",
        process.env.QA_BASE_SHA,
        "HEAD",
        "--",
        "workers/render-worker/src/composition/timeline.tsx",
      ],
      { encoding: "utf8" },
    );
    const added = diff
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"));
    const removed = diff
      .split("\n")
      .filter((line) => line.startsWith("-") && !line.startsWith("---"));
    const text = added.join("\n");
    const ok =
      removed.length === 0 &&
      text.includes("WordCaption") &&
      text.includes("captionsV1") &&
      !text.includes("innerHTML");
    return {
      status: ok ? "PASS" : "FAIL",
      expected: "no deletions in timeline.tsx",
      actual: { added: added.length, removed: removed.length },
    };
  },
);

await check(
  rows,
  "G1-CONTINUOUS-CUT",
  "An 8s continuous split keeps a crossing word's source times; a gapped word is omitted; an impossible window throws min_duration",
  () => {
    const rules = {
      maxCharacters: 32,
      maxLines: 2,
      maxCharactersPerSecond: 24,
      minDurationUs: "500000",
    };
    const trackFor = (blocks) =>
      domain.restoreCaptionTrack({
        schemaVersion: "1.0.0",
        id: id(6),
        createdBy: id(7),
        assetId: id(3),
        sourceSha256: "a".repeat(64),
        sourceDurationUs: "16000000",
        evidence: { kind: "human-timed", documentSha256: "b".repeat(64), version: "1.0.0" },
        style: { ...domain.DEFAULT_CAPTION_STYLE, preset: "landscape" },
        rules,
        blocks,
      });
    const clip = (n, inPoint, outPoint, timelineStartUs) => ({
      id: id(n),
      kind: "video",
      sourceId: id(3),
      inPoint,
      outPoint,
      timelineStartUs,
    });
    const crossing = word("cross", 7_800_000, 8_200_000, 0.9);
    const kept = word("kept", 9_000_000, 9_600_000, 0.5);
    const projected = domain.projectTimedCaptions({
      captionsV1: [
        trackFor([
          { startUs: "7600000", endUs: "8400000", lines: [[crossing]] },
          { startUs: "8800000", endUs: "9800000", lines: [[kept]] },
        ]),
      ],
      composition: { width: 640, height: 360 },
      tracks: [
        {
          clips: [clip(11, "0", "8000000", "0"), clip(12, "8000000", "16000000", "8000000")],
        },
      ],
    });
    const shown = projected.flatMap((block) => block.lines.flat());
    const cross = shown.find((item) => item.text === "cross");
    const gapped = domain.projectTimedCaptions({
      captionsV1: [
        trackFor([
          {
            startUs: "1100000",
            endUs: "1600000",
            lines: [[word("gap", 1_200_000, 1_400_000, 0.4)]],
          },
        ]),
      ],
      composition: { width: 640, height: 360 },
      tracks: [
        {
          clips: [clip(13, "0", "1000000", "0"), clip(14, "2000000", "3000000", "5000000")],
        },
      ],
    });
    let reason = "no-throw";
    try {
      domain.projectTimedCaptions({
        captionsV1: [
          trackFor([
            {
              startUs: "11800000",
              endUs: "12000000",
              lines: [[word("tail", 11_800_000, 11_950_000, null)]],
            },
          ]),
        ],
        composition: { width: 640, height: 360 },
        tracks: [{ clips: [clip(15, "11800000", "12000000", "0")] }],
      });
    } catch (error) {
      reason = error?.reason ?? "";
    }
    const owners = projected.find((block) =>
      block.lines.flat().some((item) => item.text === "cross"),
    );
    const ok =
      shown.map((item) => item.text).join("|") === "cross|kept" &&
      cross?.startUs === "7800000" &&
      cross?.endUs === "8200000" &&
      cross?.confidence === 0.9 &&
      owners?.sourceClipIds?.length === 2 &&
      gapped.length === 0 &&
      reason === "min_duration";
    return {
      status: ok ? "PASS" : "FAIL",
      expected: "crossing word kept, gap omitted, min_duration thrown",
      actual: {
        texts: shown.map((item) => item.text),
        cross,
        owners: owners?.sourceClipIds?.length ?? 0,
        gapped: gapped.length,
        reason,
      },
    };
  },
);

await check(
  rows,
  "G1-UNDO-REDO",
  "Caption command undo restores the prior snapshot and redo reapplies it",
  () => {
    const rules = {
      maxCharacters: 32,
      maxLines: 2,
      maxCharactersPerSecond: 24,
      minDurationUs: "500000",
    };
    const spoken = domain.captionWords(
      [word("Hello", 1_000_000, 1_600_000, null), word("world", 1_700_000, 2_400_000, 0.4)],
      "16000000",
    );
    const timeline = new domain.Timeline(id(1), id(2), "0", {
      composition: {
        width: 640,
        height: 360,
        frameRate: domain.frameRate(25n, 1n),
        durationUs: 16_000_000n,
      },
      sources: [{ id: id(3), kind: "video", durationUs: "16000000" }],
      tracks: [
        new domain.Track(id(4), id(1), "video", [
          new domain.Clip(id(5), id(4), "0", "16000000", { sourceId: id(3) }),
        ]),
      ],
    });
    const before = JSON.stringify(timeline.toSnapshot());
    const bus = new domain.CommandBus(timeline);
    bus.apply(
      domain.AddTimedCaption(id(8), timeline.id, {
        caption: domain.restoreCaptionTrack({
          schemaVersion: "1.0.0",
          id: id(6),
          createdBy: id(7),
          assetId: id(3),
          sourceSha256: "c".repeat(64),
          sourceDurationUs: "16000000",
          evidence: { kind: "human-timed", documentSha256: "d".repeat(64), version: "1.0.0" },
          style: domain.DEFAULT_CAPTION_STYLE,
          rules,
          blocks: domain.segmentCaptionWords(spoken, "16000000", rules),
        }),
      }),
    );
    const saved = JSON.stringify(bus.timeline.toSnapshot());
    const undone = JSON.stringify(bus.undo().toSnapshot());
    const redone = JSON.stringify(bus.redo().toSnapshot());
    const ok = before !== saved && undone === before && redone === saved;
    return {
      status: ok ? "PASS" : "FAIL",
      expected: "undo then redo round-trips the caption snapshot",
      actual: { restored: undone === before, reapplied: redone === saved },
    };
  },
);

const out = process.argv[2] ?? "/tmp/qa93-clock.json";
writeReport(out, rows, {
  suite: "clock",
  productSha: process.env.QA_APP_SHA,
  productTree: execTree(app),
});
if (rows.some((row) => row.status !== "PASS")) process.exit(1);

function execTree(root) {
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
}

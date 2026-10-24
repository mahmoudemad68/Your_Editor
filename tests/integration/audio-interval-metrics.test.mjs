import assert from "node:assert/strict";
import { test } from "node:test";
import { overlapScore } from "../../tools/audio/evaluate.mjs";
import { overlapIntervals } from "../../tools/audio/interval-metrics.mjs";

const r = (a, b) => ({ startUs: String(a), endUs: String(b) });
test("silence scores use merged unions, retain exact large times and reject invalid labels", () => {
  const p = [r(10, 20), r(0, 15), r(0, 15)],
    g = [r(5, 12), r(12, 25)];
  assert.deepEqual(overlapIntervals(p, g), {
    tp: [r(5, 20)],
    fp: [r(0, 5)],
    fn: [r(20, 25)],
  });
  assert.deepEqual(overlapScore(p, g), {
    tpUs: "15",
    fpUs: "5",
    fnUs: "5",
    precision: 0.75,
    recall: 0.75,
    f1: 0.75,
  });
  const large = 9007199254740993n;
  assert.equal(overlapScore([r(large, large + 10n)], [r(large + 1n, large + 11n)]).tpUs, "9");
  for (const invalid of [
    r(1, 1),
    r(2, 1),
    r(-1, 2),
    { startUs: 0, endUs: "1" },
    r("01", "2"),
    r("0\n", "2"),
  ])
    assert.throws(() => overlapScore([invalid], []));
});

test("independent discrete occupancy oracle agrees with duration TP/FP/FN", () => {
  // Enumerate every pair of 4-cell sets; include duplicates, overlaps and shuffled input.
  for (let p = 0; p < 16; p++)
    for (let g = 0; g < 16; g++) {
      const ranges = (mask) => {
        const result = [];
        for (let i = 3; i >= 0; i--) if (mask & (1 << i)) result.push(r(i, i + 1), r(i, i + 1));
        if ((mask & 3) === 3) result.push(r(0, 2));
        return result;
      };
      const score = overlapScore(ranges(p), ranges(g));
      let tp = 0,
        fp = 0,
        fn = 0;
      for (let i = 0; i < 4; i++) {
        const a = Boolean(p & (1 << i)),
          b = Boolean(g & (1 << i));
        if (a && b) tp++;
        if (a && !b) fp++;
        if (!a && b) fn++;
      }
      assert.deepEqual([score.tpUs, score.fpUs, score.fnUs], [tp, fp, fn].map(String));
    }
});

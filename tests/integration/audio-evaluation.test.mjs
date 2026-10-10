import { test } from "node:test";
import assert from "node:assert/strict";
import { overlapScore } from "../../tools/audio/evaluate.mjs";
const range = (startUs, endUs) => ({ startUs: String(startUs), endUs: String(endUs) });
test("audio metric honors duration overlap, touching bounds and empty conventions", () => {
  assert.equal(overlapScore([], []).f1, 1);
  assert.equal(overlapScore([], [range(0, 10)]).f1, 0);
  assert.equal(overlapScore([range(0, 10)], []).f1, 0);
  assert.equal(overlapScore([range(0, 10)], [range(10, 20)]).tpUs, "0");
  assert.equal(overlapScore([range(0, 10)], [range(0, 10)]).f1, 1);
  assert.deepEqual(overlapScore([range(0, 10)], [range(5, 15)]), {
    tpUs: "5",
    fpUs: "5",
    fnUs: "5",
    precision: 0.5,
    recall: 0.5,
    f1: 0.5,
  });
});

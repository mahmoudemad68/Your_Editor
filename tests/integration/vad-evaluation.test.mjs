import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregate, evaluate } from "../../tools/vad/evaluate.mjs";

test("US-202 fails closed without independent human evaluation gold", async () => {
  const result = await evaluate();
  assert.equal(result.AC1, "NOT_PROVEN");
  assert.equal(result.BLOCKER, "EVALUATION_GOLD_UNAVAILABLE");
  assert.equal(result.approvedHumanClipCount, 0);
  assert.equal(result.availableGeneratedArtifactIds.length, 3);
  assert.equal(result.clips, undefined);
});
test("US-202 pools integer microsecond counts instead of averaging F1", () => {
  const pooled = aggregate([
    { tpUs: "50", fpUs: "50", fnUs: "50" },
    { tpUs: "100", fpUs: "0", fnUs: "0" },
  ]);
  assert.deepEqual(pooled, {
    tpUs: "150",
    fpUs: "50",
    fnUs: "50",
    precision: 0.75,
    recall: 0.75,
    f1: 0.75,
  });
  assert.equal(aggregate([]).f1, 1);
});

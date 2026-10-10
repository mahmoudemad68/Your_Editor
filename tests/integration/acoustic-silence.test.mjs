import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACOUSTIC_CASES,
  acousticFixture,
  acousticAcceptance,
} from "../../tools/audio/acceptance.mjs";

test("US204 acoustic labels and WAV identities are fixed by samples before inference", () => {
  for (const spec of ACOUSTIC_CASES) assert.deepEqual(acousticFixture(spec), acousticFixture(spec));
  assert.deepEqual(acousticFixture(ACOUSTIC_CASES[2]).gold, [
    { startUs: "1000000", endUs: "1750000" },
    { startUs: "3000000", endUs: "4000000" },
    { startUs: "5000000", endUs: "6000000" },
  ]);
  assert.deepEqual(acousticFixture(ACOUSTIC_CASES[5]).gold, []);
});
test("US204 AC1: real default analyzer passes acoustic gaps and negative controls without a collar", async (t) => {
  const report = await acousticAcceptance();
  assert.equal(report.silenceNoiseDb, -60);
  assert.equal(report.minimumSilenceUs, "200000");
  assert.equal(report.labelledBeforeInference, true);
  assert.equal(report.AC1, "PASS");
  assert.ok(report.f1 >= 0.9);
  for (const clip of report.clips) {
    assert.ok(clip.f1 >= 0.9, clip.id);
    if (clip.gold.length === 0) assert.deepEqual(clip.predictions, [], clip.id);
  }
  t.diagnostic(JSON.stringify(report));
});

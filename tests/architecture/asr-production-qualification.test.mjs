import assert from "node:assert/strict";
import { test } from "node:test";
import { qualifyResources, qualifyWords } from "../../tools/asr/qualification.mjs";

function resources() {
  return {
    cpuQuotaUs: 200000,
    cpuPeriodUs: 100000,
    memoryLimitBytes: 3 * 1024 ** 3,
    memoryPeakBytes: 700000000,
    pidsLimit: 128,
    logicalCpus: 4,
    affinityCpus: 4,
    cpu: { usage_usec: 20000000, nr_periods: 200, nr_throttled: 130, throttled_usec: 6000000 },
    memoryEvents: { oom_kill: 0 },
  };
}

test("qualification reports the measured quota and throttling instead of host CPU count", () => {
  const before = resources(),
    after = resources();
  before.cpu = { usage_usec: 0, nr_periods: 0, nr_throttled: 0, throttled_usec: 0 };
  const result = qualifyResources(before, after);
  assert.equal(result.cpuQuota, 2);
  assert.equal(result.logicalCpus, 4);
  assert.equal(result.cpuDelta.nr_throttled, 130);
  assert.equal(result.cpuDelta.throttled_usec, 6000000);
});

for (const defect of [
  "quota",
  "period",
  "unlimited-memory",
  "pids",
  "oom",
  "peak",
  "counter",
  "missing",
  "nan",
  "idle-evidence",
  "period-evidence",
]) {
  test(`qualification cannot pass unproven resource controls: ${defect}`, () => {
    const before = resources(),
      after = resources();
    before.cpu = { usage_usec: 1, nr_periods: 0, nr_throttled: 0, throttled_usec: 0 };
    if (defect === "quota") after.cpuQuotaUs = 400000;
    if (defect === "period") after.cpuPeriodUs = 0;
    if (defect === "unlimited-memory") after.memoryLimitBytes = Infinity;
    if (defect === "pids") after.pidsLimit = 256;
    if (defect === "oom") after.memoryEvents.oom_kill = 1;
    if (defect === "peak") after.memoryPeakBytes = after.memoryLimitBytes + 1;
    if (defect === "counter") after.cpu.usage_usec = 0;
    if (defect === "missing") delete after.cpu.nr_throttled;
    if (defect === "nan") after.affinityCpus = NaN;
    if (defect === "idle-evidence") after.cpu.usage_usec = 1;
    if (defect === "period-evidence") after.cpu.nr_periods = 0;
    assert.throws(() => qualifyResources(before, after));
  });
}

// Synthetic unit inputs test rejection controls only; they never enter inference/evaluation.
function unitWords() {
  return Array.from({ length: 700 }, (_, index) => {
    const start = Math.floor(index / 70) * 60000000 + (index % 70) * 800000;
    return {
      text: " unit",
      startUs: String(start),
      endUs: String(start + 500000),
      confidence: 0.8,
    };
  });
}

test("qualification retains complete ordered native intervals without rewriting input", () => {
  const words = unitWords(),
    original = JSON.parse(JSON.stringify(words));
  assert.equal(qualifyWords(words), 700);
  assert.deepEqual(words, original);
});

for (const defect of [
  "zero",
  "overlap",
  "outside",
  "negative",
  "newline",
  "confidence",
  "empty",
  "sparse-minute",
]) {
  test(`qualification rejects incomplete word evidence: ${defect}`, () => {
    let words = unitWords();
    if (defect === "zero") words[5].endUs = words[5].startUs;
    if (defect === "overlap") words[5].startUs = "0";
    if (defect === "outside") words.at(-1).endUs = "600000001";
    if (defect === "negative") words[0].startUs = "-1";
    if (defect === "newline") words[0].startUs = "0\n";
    if (defect === "confidence") words[0].confidence = NaN;
    if (defect === "empty") words[0].text = " ";
    if (defect === "sparse-minute") words = words.filter((_, index) => index < 300 || index >= 350);
    assert.throws(() => qualifyWords(words));
  });
}

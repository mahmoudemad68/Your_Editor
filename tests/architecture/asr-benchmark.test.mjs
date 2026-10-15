import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("the ASR spike unit tests stay deterministic and do not download models", () => {
  const result = spawnSync("python3", ["tools/benchmarks/asr/tests/test_asr_benchmark.py"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

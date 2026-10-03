import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("the LLM spike unit tests stay offline and do not call providers", () => {
  const result = spawnSync("python3", ["tools/benchmarks/llm/tests/test_llm_benchmark.py"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

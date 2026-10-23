import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { analysisConfiguration } from "../../packages/analysis-core/dist/configuration.js";

test("admitted analysis jobs declare the actual Python ASR algorithm", () => {
  const source = readFileSync(
    new URL(
      "../../workers/ai-worker/src/editagent_ai_worker/infrastructure/faster_whisper.py",
      import.meta.url,
    ),
    "utf8",
  );
  const declarations = [...source.matchAll(/^ASR_ALGORITHM = "([a-z0-9-]+)"\r?$/gm)];
  assert.equal(declarations.length, 1);
  for (const model of ["tiny", "small"])
    assert.equal(
      analysisConfiguration({ EDITAGENT_ASR_MODEL: model }).asrAlgorithm,
      declarations[0][1],
    );
});

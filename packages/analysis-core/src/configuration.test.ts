import { test } from "node:test";
import assert from "node:assert/strict";
import { analysisConfiguration } from "./configuration.js";
import { configurationHash } from "./infrastructure/postgres-analysis.js";

test("configuration identity includes model, schema and actual deployment parameters", () => {
  const a = analysisConfiguration({}),
    b = analysisConfiguration({ EDITAGENT_ASR_MODEL: "tiny" });
  assert.equal(a.schemaVersion, "1.1.0");
  assert.notEqual(a.modelRevision, b.modelRevision);
  assert.notEqual(configurationHash(a), configurationHash(b));
  assert.notEqual(
    configurationHash(a),
    configurationHash(analysisConfiguration({ EDITAGENT_VAD_PADDING_US: "200000" })),
  );
  assert.deepEqual(a, analysisConfiguration({}));
  assert.equal(a.asrAlgorithm, "ct2-contextual-v8");
  assert.notEqual(
    configurationHash(a),
    configurationHash({ ...a, asrAlgorithm: "ct2-contextual-v6" }),
  );
});
test("unsafe deployment configuration fails before admission", () => {
  for (const env of [
    { EDITAGENT_ASR_TIMEOUT_MS: "0" },
    { EDITAGENT_ASR_CPU_THREADS: "999" },
    { EDITAGENT_ASR_SPEECH_THRESHOLD: "1" },
    { EDITAGENT_ASR_MODEL: "../../model" },
    { EDITAGENT_ASR_CHUNK_US: "30000000" },
    { EDITAGENT_VAD_PADDING_US: "-1" },
    { EDITAGENT_VAD_NEGATIVE_THRESHOLD: "0.9" },
    { EDITAGENT_VAD_TIMEOUT_MS: "null" },
  ])
    assert.throws(() => analysisConfiguration(env));
});

test("PostgreSQL JSONB key order cannot change configuration identity", () => {
  const original = analysisConfiguration({});
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  assert.equal(configurationHash(original), configurationHash(reordered));
  assert.throws(() => configurationHash({ threshold: Number.NaN }));
});

test("invalid operator values cannot escape through JSON parser diagnostics", () => {
  for (const key of [
    "EDITAGENT_ASR_TIMEOUT_MS",
    "EDITAGENT_ASR_CPU_FALLBACK",
    "EDITAGENT_VAD_TIMEOUT_MS",
  ]) {
    assert.throws(
      () => analysisConfiguration({ [key]: "sensitive-operator-value" }),
      (error: unknown) =>
        error instanceof Error && error.message === "Invalid analysis deployment configuration.",
    );
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMediaAnalysisV1_1 } from "@editagent/schemas";
import { assertOutsideProtectedWords, withSection } from "./contracts.js";

const absent = { status: "not_available" };
const initial = () =>
  validateMediaAnalysisV1_1({
    schemaVersion: "1.1.0",
    mediaAssetId: "01900000-0000-7000-8000-000000000001",
    source: { sha256: "a".repeat(64), durationUs: "1000000" },
    provenance: { producer: "test", producerVersion: "1" },
    sections: {
      metadata: absent,
      transcript: absent,
      audio: absent,
      scenes: absent,
      faces: absent,
      objects: absent,
    },
  });
test("aggregation changes only its own section and never mutates input", () => {
  const before = initial();
  const encoded = JSON.stringify(before);
  const after = withSection(before, "transcript", {
    status: "failed",
    failure: { code: "internal", reason: "Analysis failed.", retryable: true },
  });
  assert.equal(JSON.stringify(before), encoded);
  assert.deepEqual(after.sections.audio, before.sections.audio);
  assert.equal(after.sections.transcript.status, "failed");
});
test("protected words use exact half-open source time and fail closed without transcript", () => {
  assert.throws(() => assertOutsideProtectedWords(initial(), [{ startUs: "0", endUs: "1" }]));
  const doc = withSection(initial(), "transcript", {
    status: "completed",
    data: {
      language: "en",
      segments: [
        {
          id: "word-0",
          text: "hello",
          startUs: "100",
          endUs: "200",
          words: [{ text: "hello", startUs: "100", endUs: "200", confidence: 0.9 }],
        },
      ],
    },
    provenance: {
      analyzer: "test",
      analyzerVersion: "1",
      sourceSha256: "a".repeat(64),
      configurationSha256: "b".repeat(64),
    },
  });
  assert.doesNotThrow(() =>
    assertOutsideProtectedWords(doc, [
      { startUs: "0", endUs: "100" },
      { startUs: "200", endUs: "300" },
    ]),
  );
  assert.throws(() => assertOutsideProtectedWords(doc, [{ startUs: "199", endUs: "300" }]));
  assert.throws(() => assertOutsideProtectedWords(doc, [{ startUs: "0", endUs: "1000001" }]));
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { frameRate, frameTime } from "@editagent/domain";
import { validateMediaAnalysisV1_1 } from "@editagent/schemas";
import {
  assertSafeAutomaticSilenceRemoval,
  SILENCE_REMOVAL_QUALIFICATION,
} from "./silence-safety.js";

const absent = { status: "not_available" };
const provenance = {
  analyzer: "ffmpeg-audio",
  analyzerVersion: "us204-v1",
  sourceSha256: "a".repeat(64),
  configurationSha256: "b".repeat(64),
};
const range = (startUs: string, endUs: string) => ({ startUs, endUs });
function document() {
  return validateMediaAnalysisV1_1({
    schemaVersion: "1.1.0",
    mediaAssetId: "01900000-0000-7000-8000-000000000001",
    source: { sha256: "a".repeat(64), durationUs: "2000000" },
    provenance: { producer: "test", producerVersion: "1" },
    sections: {
      metadata: absent,
      scenes: absent,
      faces: absent,
      objects: absent,
      audio: { status: "completed", provenance, data: { silence: [range("0", "2000000")] } },
      transcript: {
        status: "completed",
        provenance: { ...provenance, analyzer: "test" },
        data: {
          language: "en",
          segments: [
            {
              id: "protected",
              text: "protected",
              ...range("400000", "600000"),
              words: [{ text: "protected", confidence: 0.9, ...range("400000", "600000") }],
            },
          ],
        },
      },
    },
  });
}
test("nonempty automatic removal remains fail-closed even for an acoustic candidate", () => {
  assert.equal(SILENCE_REMOVAL_QUALIFICATION, "NOT_MET");
  const doc = document(),
    before = JSON.stringify(doc);
  assert.throws(
    () => assertSafeAutomaticSilenceRemoval(doc, [range("0", "100000")], frameRate(20n, 1n)),
    /CP2_NOT_MET/,
  );
  assert.doesNotThrow(() => assertSafeAutomaticSilenceRemoval(doc, [], frameRate(20n, 1n)));
  assert.throws(
    () =>
      assertSafeAutomaticSilenceRemoval(
        doc,
        { length: 0 } as unknown as Parameters<typeof assertSafeAutomaticSilenceRemoval>[1],
        frameRate(20n, 1n),
      ),
    /range list/,
  );
  assert.equal(JSON.stringify(doc), before);
  doc.sections.audio = { status: "not_available" };
  assert.throws(
    () => assertSafeAutomaticSilenceRemoval(doc, [range("0", "100000")], frameRate(20n, 1n)),
    /NON_SPEECH/,
  );
});
test("words and their 50ms padding are protected before qualification is considered", () => {
  for (const cut of [
    range("400000", "600000"),
    range("300000", "400000"),
    range("600000", "650000"),
  ])
    assert.throws(
      () => assertSafeAutomaticSilenceRemoval(document(), [cut], frameRate(20n, 1n)),
      /padded speech/,
    );
  assert.throws(
    () =>
      assertSafeAutomaticSilenceRemoval(
        document(),
        [range("650000", "700000")],
        frameRate(20n, 1n),
      ),
    /CP2_NOT_MET/,
  );
  const doc = document();
  doc.sections.transcript = { status: "not_available" };
  assert.throws(
    () => assertSafeAutomaticSilenceRemoval(doc, [range("0", "100000")], frameRate(20n, 1n)),
    /transcript/,
  );
});
test("NON_SPEECH, wrong source positions and outward frame rounding cannot authorize cuts", () => {
  const doc = document();
  if (doc.sections.audio.status !== "completed") throw new Error("fixture");
  doc.sections.audio.provenance.analyzer = "silero-vad";
  assert.throws(
    () => assertSafeAutomaticSilenceRemoval(doc, [range("0", "100000")], frameRate(20n, 1n)),
    /NON_SPEECH/,
  );
  doc.sections.audio.provenance.analyzer = "ffmpeg-audio";
  doc.sections.audio.data.silence = [range("1000000", "2000000")];
  assert.throws(
    () => assertSafeAutomaticSilenceRemoval(doc, [range("0", "100000")], frameRate(20n, 1n)),
    /contained/,
  );
  const ntsc = frameRate(30000n, 1001n),
    end = frameTime(1n, ntsc);
  assert.throws(
    () => assertSafeAutomaticSilenceRemoval(document(), [range("0", String(end - 1n))], ntsc),
    /frame boundaries/,
  );
  assert.throws(
    () => assertSafeAutomaticSilenceRemoval(document(), [range("0", String(end))], ntsc),
    /CP2_NOT_MET/,
  );
  for (const cut of [
    range("0", "2000001"),
    range("0", "0"),
    range("01", "100000"),
    range("0\n", "100000"),
  ])
    assert.throws(() => assertSafeAutomaticSilenceRemoval(document(), [cut], frameRate(20n, 1n)));
});

test("existing speech evidence protects source-coordinate regions even with an empty transcript", () => {
  const fixture = JSON.parse(
    readFileSync(resolve(__dirname, "../../schemas/fixtures/media-analysis/us202.json"), "utf8"),
  );
  const doc = validateMediaAnalysisV1_1({
    ...fixture,
    schemaVersion: "1.1.0",
    sections: {
      ...fixture.sections,
      transcript: { status: "completed", data: { language: "en", segments: [] }, provenance },
      audio: {
        ...fixture.sections.audio,
        provenance,
        data: { ...fixture.sections.audio.data, silence: [range("30000000", "90000000")] },
      },
    },
  });
  assert.throws(
    () =>
      assertSafeAutomaticSilenceRemoval(doc, [range("31950000", "32050000")], frameRate(20n, 1n)),
    /padded speech/,
  );
  assert.throws(
    () =>
      assertSafeAutomaticSilenceRemoval(doc, [range("32050000", "32100000")], frameRate(20n, 1n)),
    /CP2_NOT_MET/,
  );
  if (doc.sections.audio.status !== "completed") throw new Error("fixture");
  doc.sections.audio.provenance.sourceSha256 = "c".repeat(64);
  assert.throws(() =>
    assertSafeAutomaticSilenceRemoval(doc, [range("32050000", "32100000")], frameRate(20n, 1n)),
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FFmpegAudioAnalyzer } from "../../packages/media-core/dist/index.js";
import { validateMediaAnalysisV1_1 } from "../../packages/schemas/dist/index.js";
import { assertSafeAutomaticSilenceRemoval } from "../../packages/analysis-core/dist/index.js";
import { safetyFixtures } from "../../tools/audio/safety-fixtures.mjs";

test("real acoustic detection preserves audible music/noise and cannot qualify quiet speech/music removal", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "us204-safety-"));
  try {
    for (const fixture of safetyFixtures()) {
      const filePath = join(directory, `${fixture.id}.wav`);
      await writeFile(filePath, fixture.bytes);
      const analysis = await new FFmpegAudioAnalyzer().analyze({
        filePath,
        durationUs: fixture.durationUs,
        sourceSha256: fixture.sha256,
        inputSha256: fixture.sha256,
        inputArtifactId: fixture.id,
      });
      const expected = fixture.expectsWholeClipAcousticSilence
        ? [{ startUs: "0", endUs: String(fixture.durationUs) }]
        : [];
      assert.deepEqual(analysis.data.silence, expected, fixture.id);
      const absent = { status: "not_available" };
      const doc = validateMediaAnalysisV1_1({
        schemaVersion: "1.1.0",
        mediaAssetId: "01900000-0000-7000-8000-000000000001",
        source: { sha256: fixture.sha256, durationUs: String(fixture.durationUs) },
        provenance: { producer: "test", producerVersion: "1" },
        sections: {
          metadata: absent,
          transcript: absent,
          audio: analysis,
          scenes: absent,
          faces: absent,
          objects: absent,
        },
      });
      if (expected.length)
        assert.throws(
          () =>
            assertSafeAutomaticSilenceRemoval(doc, expected, { numerator: 25n, denominator: 1n }),
          /transcript/,
        );
      // Even a completed empty transcript cannot authorize deleting quiet music.
      doc.sections.transcript = {
        status: "completed",
        data: { language: "en", segments: [] },
        provenance: { ...analysis.provenance, analyzer: "test-empty-transcript" },
      };
      if (expected.length)
        assert.throws(
          () =>
            assertSafeAutomaticSilenceRemoval(doc, expected, { numerator: 25n, denominator: 1n }),
          /CP2_NOT_MET/,
        );
      t.diagnostic(
        JSON.stringify({
          id: fixture.id,
          role: fixture.role,
          sha256: fixture.sha256,
          parentSha256: fixture.parentSha256,
          predictions: analysis.data.silence,
          automaticRemoval: "BLOCKED",
        }),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

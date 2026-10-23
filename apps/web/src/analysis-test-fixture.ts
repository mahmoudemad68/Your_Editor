/** Synthetic product contract data; not model output or evaluation gold. */
export const ANALYSIS_PROJECT = "018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f";
export const ANALYSIS_MEDIA = "018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e40";
export function analysisFixture(schemaVersion = "1.1.0") {
  const unavailable = { status: "not_available" };
  return {
    schemaVersion,
    mediaAssetId: ANALYSIS_MEDIA,
    source: { sha256: "a".repeat(64), durationUs: "2000000" },
    provenance: { producer: "fixture", producerVersion: "1.0.0" },
    sections: {
      metadata: unavailable,
      transcript: {
        status: "completed",
        data: {
          language: "ar",
          segments: [
            {
              id: "segment-1",
              text: "Hello مرحبا",
              startUs: "0",
              endUs: "1000000",
              words: [
                { text: "Hello", startUs: "0", endUs: "500000", confidence: 0.9 },
                { text: " مرحبا", startUs: "600000", endUs: "1000000", confidence: 0.8 },
              ],
            },
          ],
        },
        provenance: {
          analyzer: "fixture",
          analyzerVersion: "1.0.0",
          sourceSha256: "a".repeat(64),
          configurationSha256: "b".repeat(64),
        },
      },
      audio: {
        status: "failed",
        failure: { code: "timeout", reason: "Analysis timed out.", retryable: true },
      },
      scenes: unavailable,
      faces: unavailable,
      objects: unavailable,
    },
  };
}

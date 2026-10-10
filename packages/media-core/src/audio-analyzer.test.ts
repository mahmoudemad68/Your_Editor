import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  FFmpegAudioAnalyzer,
  DEFAULT_AUDIO_ANALYSIS_CONFIG,
  validateAudioAnalysisConfig,
} from "./audio-analyzer.js";
import {
  decimalSecondsUs,
  parseSilence,
  parseLoudness,
  PcmBuckets,
} from "./audio-analysis-parsers.js";
import { MediaAnalysisV1_1Schema as MediaAnalysisSchema } from "@editagent/schemas";

function wav(
  seconds: number,
  amplitude: (sample: number) => number,
  rate = 48000,
  channels = 1,
): Buffer {
  const count = seconds * rate;
  const body = Buffer.alloc(44 + count * channels * 4);
  body.write("RIFF", 0);
  body.writeUInt32LE(body.length - 8, 4);
  body.write("WAVEfmt ", 8);
  body.writeUInt32LE(16, 16);
  body.writeUInt16LE(3, 20);
  body.writeUInt16LE(channels, 22);
  body.writeUInt32LE(rate, 24);
  body.writeUInt32LE(rate * channels * 4, 28);
  body.writeUInt16LE(channels * 4, 32);
  body.writeUInt16LE(32, 34);
  body.write("data", 36);
  body.writeUInt32LE(body.length - 44, 40);
  for (let n = 0; n < count; n++)
    for (let c = 0; c < channels; c++)
      body.writeFloatLE(c === 0 ? amplitude(n) : 0, 44 + (n * channels + c) * 4);
  return body;
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
test("strict configurable thresholds, integer bucket timing and safe decimal conversion", () => {
  for (const silenceNoiseDb of [NaN, Infinity, -101, 1])
    assert.throws(() =>
      validateAudioAnalysisConfig({ ...DEFAULT_AUDIO_ANALYSIS_CONFIG, silenceNoiseDb }),
    );
  for (const minimumSilenceUs of [0n, -1n, 10000001n])
    assert.throws(() =>
      validateAudioAnalysisConfig({ ...DEFAULT_AUDIO_ANALYSIS_CONFIG, minimumSilenceUs }),
    );
  assert.equal(decimalSecondsUs("0"), 0n);
  assert.equal(decimalSecondsUs("0.0000005"), 1n);
  assert.equal(decimalSecondsUs("1.2345674"), 1234567n);
  assert.equal(decimalSecondsUs("9007199254.740993"), 9007199254740993n);
  for (const value of ["1e4", "NaN", "Infinity", "0.2\n", "1,2"])
    assert.throws(() => decimalSecondsUs(value));
});
test("silence boundaries, trailing closure and malformed diagnostics", () => {
  assert.deepEqual(
    parseSilence(
      "silence_start: 0\nsilence_end: 1 | silence_duration: 1\nsilence_start: 2\n",
      3000000n,
    ),
    [
      { startUs: "0", endUs: "1000000" },
      { startUs: "2000000", endUs: "3000000" },
    ],
  );
  for (const text of [
    "silence_start: NaN",
    "silence_end: 1 | silence_duration: 1",
    "silence_start: 2\nsilence_end: 1 | silence_duration: 1",
    "silence_start: 0\nsilence_start: 1",
    "silence_start: 0\nsilence_end: 4 | silence_duration: 4",
    "silence_start: 0\nsilence_end: 1 | silence_duration: 0.2",
  ])
    assert.throws(() => parseSilence(text, 3000000n));
  for (const text of [
    "",
    "Summary:\n I: NaN LUFS",
    "Summary:\n I: -23 LUFS\nLRA: Infinity LU\nPeak: 0 dBFS",
  ])
    assert.throws(() => parseLoudness(text, 3000000n));
});
test("PCM chunk boundaries, exact buckets, dBFS energy and normalized peaks", () => {
  const bytes = Buffer.alloc(8000 * 4);
  for (let i = 0; i < 8000; i++) bytes.writeFloatLE(i % 2 ? -0.5 : 0.5, i * 4);
  const curve = new PcmBuckets(8000, 100000n, 1000000n);
  for (let i = 0; i < bytes.length; i += 317) curve.push(bytes.subarray(i, i + 317));
  curve.finish();
  assert.equal(curve.energyCurve.length, 10);
  assert.equal(curve.waveformPeaks.length, 10);
  assert.ok(Math.abs(curve.energyCurve[0]!.rmsDbfs + 6.020599913) < 1e-8);
  assert.deepEqual(curve.waveformPeaks[0], { atUs: "0", minimum: -0.5, maximum: 0.5 });
  assert.throws(() => new PcmBuckets(8000, 100000n, 1000000n).finish());
});
function filterGain(b: number[], a: number[], frequency: number): number {
  const omega = (2 * Math.PI * frequency) / 48000;
  const magnitude = (coeffs: number[]) => {
    let re = 0,
      im = 0;
    for (let i = 0; i < coeffs.length; i++) {
      re += coeffs[i]! * Math.cos(omega * i);
      im -= coeffs[i]! * Math.sin(omega * i);
    }
    return re * re + im * im;
  };
  return magnitude(b) / magnitude(a);
}
// Analytical steady-state BS.1770 mono 1kHz 0.1-peak sine reference, fixed before rendering.
const referenceLufs =
  -0.691 +
  10 *
    Math.log10(
      (0.1 ** 2 / 2) *
        filterGain(
          [1.53512485958697, -2.69169618940638, 1.19839281085285],
          [1, -1.69065929318241, 0.73248077421585],
          1000,
        ) *
        filterGain([1, -2, 1], [1, -1.99004745483398, 0.99007225036621], 1000),
    );
test("real FFmpeg calibrated loudness, schema integration, repeatability and known silence", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "audio-analysis-test-"));
  try {
    const tone = wav(10, (n) => 0.1 * Math.sin((2 * Math.PI * 1000 * n) / 48000));
    const filePath = path.join(directory, "tone.wav");
    await writeFile(filePath, tone);
    const input = {
      filePath,
      durationUs: 10000000n,
      sourceSha256: digest(tone),
      inputSha256: digest(tone),
      inputArtifactId: "calibrated-tone",
    };
    const analyzer = new FFmpegAudioAnalyzer();
    const first = await analyzer.analyze(input),
      second = await analyzer.analyze(input);
    assert.deepEqual(first, second);
    const measured = first.data.loudness!.integratedLufs!;
    assert.ok(
      Math.abs(measured - referenceLufs) <= 0.5,
      `reference=${referenceLufs}, measured=${measured}`,
    );
    console.log(
      JSON.stringify({
        REFERENCE_LUFS: referenceLufs,
        MEASURED_LUFS: measured,
        ABS_ERROR_LU: Math.abs(measured - referenceLufs),
      }),
    );
    assert.equal(first.data.energyCurve?.length, 100);
    assert.ok(first.data.shortTermLoudness!.length > 0);
    MediaAnalysisSchema.parse({
      schemaVersion: "1.1.0",
      mediaAssetId: "01900000-0000-7000-8000-000000000001",
      source: { sha256: input.sourceSha256, durationUs: input.durationUs.toString() },
      provenance: { producer: "audio-test", producerVersion: "1" },
      sections: {
        metadata: { status: "not_available" },
        transcript: { status: "not_available" },
        audio: first,
        scenes: { status: "not_available" },
        faces: { status: "not_available" },
        objects: { status: "not_available" },
      },
    });
    const quiet = wav(1, (n) => 0.001 * Math.sin((2 * Math.PI * 1000 * n) / 48000));
    await writeFile(filePath, quiet);
    const quietResult = await analyzer.analyze({
      ...input,
      durationUs: 1000000n,
      inputSha256: digest(quiet),
      sourceSha256: digest(quiet),
    });
    assert.equal(
      quietResult.data.silence!.length,
      0,
      "-60 dB preserves a -60 dBFS peak quiet tone rather than classifying its waveform as silence",
    );
    const mixed = wav(4, (n) =>
      n >= 48000 && n < 144000 ? 0.1 * Math.sin((2 * Math.PI * 1000 * n) / 48000) : 0,
    );
    await writeFile(filePath, mixed);
    const result = await analyzer.analyze({
      ...input,
      durationUs: 4000000n,
      sourceSha256: digest(mixed),
      inputSha256: digest(mixed),
    });
    assert.equal(result.data.silence!.length, 2);
    assert.ok(
      BigInt(result.data.silence![0]!.endUs) >= 999900n &&
        BigInt(result.data.silence![0]!.endUs) <= 1000100n,
    );
    assert.equal(result.data.silence![1]!.endUs, "4000000");
    const scoped = await analyzer.analyze({
      ...input,
      durationUs: 4000000n,
      inputSha256: digest(mixed),
      sourceSha256: digest(mixed),
      scopeStartUs: 30000000n,
      sourceDurationUs: 90000000n,
    });
    assert.equal(scoped.data.silence![0]!.startUs, "30000000");
    assert.equal(scoped.data.silence![1]!.endUs, "34000000");
    assert.equal(scoped.data.energyCurve![0]!.atUs, "30000000");
    await assert.rejects(analyzer.analyze({ ...input, scopeStartUs: -1n }), /scope/);

    await assert.rejects(analyzer.analyze({ ...input, inputSha256: "0".repeat(64) }), /checksum/);
    const silent = wav(1, () => 0);
    await writeFile(filePath, silent);
    const silenceOnly = await analyzer.analyze({
      ...input,
      durationUs: 1000000n,
      inputSha256: digest(silent),
      sourceSha256: digest(silent),
    });
    assert.deepEqual(silenceOnly.data.silence, [{ startUs: "0", endUs: "1000000" }]);
    assert.equal(silenceOnly.data.loudness!.truePeakDbtp, -200);
    for (const [rate, channels] of [
      [16000, 1],
      [48000, 2],
    ] as const) {
      const bytes = wav(1, (n) => 0.1 * Math.sin((2 * Math.PI * 1000 * n) / rate), rate, channels);
      await writeFile(filePath, bytes);
      const output = await analyzer.analyze({
        ...input,
        durationUs: 1000000n,
        inputSha256: digest(bytes),
        sourceSha256: digest(bytes),
      });
      assert.equal(output.data.energyCurve!.length, 10);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

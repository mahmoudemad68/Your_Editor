/** Acoustic gold is defined by fixed PCM sample counts BEFORE production inference. */
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import console from "node:console";
import {
  FFmpegAudioAnalyzer,
  DEFAULT_AUDIO_ANALYSIS_CONFIG,
} from "../../packages/media-core/dist/index.js";
import { overlapScore } from "./evaluate.mjs";
import { aggregate } from "../vad/evaluate.mjs";

const RATE = 48000;
// Integer milliseconds each span an exact number of samples. No predicted boundaries.
export const ACOUSTIC_CASES = Object.freeze(
  [
    { id: "no-silence", blocks: [[2000, "tone"]] },
    {
      id: "internal-gap",
      blocks: [
        [1000, "tone"],
        [1000, "zero"],
        [1000, "tone"],
      ],
    },
    {
      id: "multiple-and-trailing",
      blocks: [
        [1000, "tone"],
        [750, "zero"],
        [1250, "tone"],
        [1000, "zero"],
        [1000, "tone"],
        [1000, "zero"],
      ],
    },
    {
      id: "trailing",
      blocks: [
        [1000, "tone"],
        [1000, "zero"],
      ],
    },
    {
      id: "touching-boundaries",
      blocks: [
        [500, "zero"],
        [500, "tone"],
        [500, "zero"],
        [500, "tone"],
      ],
    },
    {
      id: "subminimum-gap",
      blocks: [
        [1000, "tone"],
        [100, "zero"],
        [1000, "tone"],
      ],
    },
    { id: "quiet-nonsilent", blocks: [[2000, "quiet"]] },
  ].map((c) =>
    Object.freeze({ ...c, blocks: Object.freeze(c.blocks.map((b) => Object.freeze(b))) }),
  ),
);

export function acousticFixture(spec) {
  let count = 0;
  const gold = [];
  for (const [ms, kind] of spec.blocks) {
    const samples = (ms * RATE) / 1000;
    if (!Number.isSafeInteger(samples) || samples <= 0 || !["tone", "quiet", "zero"].includes(kind))
      throw new Error("Invalid acoustic fixture construction.");
    if (kind === "zero" && BigInt(ms) * 1000n >= DEFAULT_AUDIO_ANALYSIS_CONFIG.minimumSilenceUs)
      gold.push({
        startUs: String((BigInt(count) * 1000000n) / BigInt(RATE)),
        endUs: String((BigInt(count + samples) * 1000000n) / BigInt(RATE)),
      });
    count += samples;
  }
  if (count > RATE * 10) throw new Error("Fixture size exceeds fixed test bound.");
  const bytes = Buffer.alloc(44 + count * 2);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(RATE, 24);
  bytes.writeUInt32LE(RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(count * 2, 40);
  let n = 0;
  for (const [ms, kind] of spec.blocks)
    for (let i = 0; i < (ms * RATE) / 1000; i++, n++) {
      // Exact integer 1 kHz square tone; quiet peak=128/32768 (~-48 dBFS), above -60 dB.
      const value = kind === "zero" ? 0 : (n % 48 < 24 ? 1 : -1) * (kind === "quiet" ? 128 : 4096);
      bytes.writeInt16LE(value, 44 + n * 2);
    }
  return {
    bytes,
    gold,
    durationUs: (BigInt(count) * 1000000n) / BigInt(RATE),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function acousticAcceptance() {
  const analyzer = new FFmpegAudioAnalyzer(); // Unchanged -60 dB / 200 ms production defaults.
  const directory = await mkdtemp(join(tmpdir(), "us204-acoustic-"));
  const clips = [];
  try {
    for (const spec of ACOUSTIC_CASES) {
      const fixture = acousticFixture(spec); // Gold constructed before analyze().
      const filePath = join(directory, `${spec.id}.wav`);
      await writeFile(filePath, fixture.bytes);
      const analysis = await analyzer.analyze({
        filePath,
        durationUs: fixture.durationUs,
        sourceSha256: fixture.sha256,
        inputSha256: fixture.sha256,
        inputArtifactId: spec.id,
      });
      const predictions = analysis.data.silence;
      clips.push({
        id: spec.id,
        sha256: fixture.sha256,
        durationUs: String(fixture.durationUs),
        gold: fixture.gold,
        predictions,
        ...overlapScore(predictions, fixture.gold),
      });
    }
    const score = aggregate(clips);
    return {
      role: "US204_AC1_KNOWN_ACOUSTIC_SILENCE_FIXTURE",
      labelledBeforeInference: true,
      silenceNoiseDb: analyzer.configuration.silenceNoiseDb,
      minimumSilenceUs: String(analyzer.configuration.minimumSilenceUs),
      metric: "Half-open integer-us duration overlap; no collar; pooled TP/FP/FN",
      ...score,
      AC1: score.f1 >= 0.9 && clips.every((c) => c.f1 >= 0.9) ? "PASS" : "FAIL",
      clips,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error("Usage: pnpm audio:acceptance");
    const report = await acousticAcceptance();
    console.log(JSON.stringify(report, null, 2));
    if (report.AC1 !== "PASS") process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

/** Real licensed ten-minute source, bounded canonical extraction and production CPU inference. */
import { createReadStream } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { runWorkerPython } from "./process.mjs";
import { hashStream } from "../evaluation/storage.mjs";
import { buildFfmpegArgs, FfmpegExecutor } from "../../packages/media-core/dist/index.js";
const root = path.resolve(import.meta.dirname, "../..");
const datasetRoot = process.argv[2];
if (!datasetRoot) throw new Error("usage: node tools/asr/long-input.mjs LOCAL_DATASET");
const modelIndex = process.argv.indexOf("--model");
const model = modelIndex < 0 ? "tiny" : process.argv[modelIndex + 1];
if (!["tiny", "small"].includes(model)) throw new Error("Unsupported long-input model");
const manifest = JSON.parse(
  await readFile(path.join(root, "docs/evaluation/manifest.json"), "utf8"),
);
const source = manifest.sources.find((s) => s.id === "commons-148215183");
const original = path.resolve(datasetRoot, source.id + "." + source.extension);
const checked = await hashStream(createReadStream(original));
if (checked.sha256 !== source.sha256 || checked.sizeBytes !== source.sizeBytes)
  throw new Error("Long source identity differs");
const dir = path.join(root, ".local/asr-batch");
await mkdir(dir, { recursive: true });
const audio = path.join(dir, "ten-minute.wav");
await new FfmpegExecutor().execute(
  buildFfmpegArgs({
    input: { path: original, durationUs: 600000000n },
    output: {
      path: audio,
      format: "wav",
      maps: ["0:a:0"],
      audioEncoder: "pcm_s16le",
      sampleRate: 16000,
      channels: 1,
    },
  }),
  { timeoutMs: 120000 },
);
const hash = await hashStream(createReadStream(audio));
const identity = path.join(dir, "ten-minute-identity.json");
await writeFile(
  identity,
  JSON.stringify({
    source_id: source.id,
    source_sha256: source.sha256,
    artifact_id: "ten-minute-asr",
    audio_sha256: hash.sha256,
    source_duration_us: Number(source.durationUs),
    scope_start_us: 0,
    scope_end_us: 600000000,
  }),
);
const raw = await runWorkerPython("transcribe", ["--audio", audio, "--identity", identity], {
  env: {
    ...process.env,
    EDITAGENT_ASR_MODEL: model,
    EDITAGENT_ASR_MODEL_ROOT: path.join(root, ".local/asr-models"),
  },
});
const result = JSON.parse(raw);
if (result.section?.status !== "completed") throw new Error("Ten-minute transcription failed");
const words = result.section.data.segments.flatMap((s) => s.words);
if (
  !words.length ||
  words.some(
    (w, i) =>
      BigInt(w.startUs) >= BigInt(w.endUs) ||
      BigInt(w.endUs) > 600000000n ||
      (i && BigInt(words[i - 1].endUs) > BigInt(w.startUs)),
  )
)
  throw new Error("Long word integrity failed");
const report = {
  runId: randomUUID(),
  sourceId: source.id,
  sourceSha256: source.sha256,
  audioSha256: hash.sha256,
  durationUs: "600000000",
  wordCount: words.length,
  detectedLanguage: result.section.data.language,
  wallTimeMs: result.wallTimeMs,
  realTimeFactor: result.wallTimeMs / 600000,
  peakRssBytes: result.peakRssBytes,
  modelProvenance: result.section.provenance,
  inferenceParameters: result.inferenceParameters,
  recognizedText: words.map((word) => word.text).join(""),
  transcriptSha256: createHash("sha256").update(JSON.stringify(result.section)).digest("hex"),
  wer: "NOT_MEASURED_NO_REFERENCE_FOR_THIS_SCOPE",
  license: source.license,
};
await writeFile(path.join(dir, `ten-minute-${model}-transcript.json`), raw);
await writeFile(
  path.join(dir, `ten-minute-${model}-evidence.json`),
  JSON.stringify(report, null, 2) + "\n",
);
process.stdout.write(JSON.stringify(report, null, 2) + "\n");

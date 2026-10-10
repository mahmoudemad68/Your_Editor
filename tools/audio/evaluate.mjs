/** Diagnostic only: acoustic silence vs unchanged Silero-derived non-speech project gold. */
import { resolve } from "node:path";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";
import console from "node:console";
import { performance } from "node:perf_hooks";
import { loadDataset } from "../evaluation/validate.mjs";
import { hashStream } from "../evaluation/storage.mjs";
import { scopedMetricInputs } from "../evaluation/scoped-inputs.mjs";
import { selectEvaluationClips, aggregate } from "../vad/evaluate.mjs";
import { FFmpegAudioAnalyzer } from "../../packages/media-core/dist/index.js";

export function overlapScore(predictions, gold) {
  const duration = (ranges) => ranges.reduce((n, r) => n + BigInt(r.endUs) - BigInt(r.startUs), 0n);
  let tp = 0n;
  for (const p of predictions)
    for (const g of gold) {
      const a = BigInt(p.startUs) > BigInt(g.startUs) ? BigInt(p.startUs) : BigInt(g.startUs);
      const b = BigInt(p.endUs) < BigInt(g.endUs) ? BigInt(p.endUs) : BigInt(g.endUs);
      if (a < b) tp += b - a;
    }
  return aggregate([
    {
      tpUs: String(tp),
      fpUs: String(duration(predictions) - tp),
      fnUs: String(duration(gold) - tp),
    },
  ]);
}
export async function evaluateAudio(root) {
  if (!root)
    throw new Error("Use --root with verified source/scoped WAV bytes; no missing-clip skips.");
  const dataset = loadDataset();
  const { clips } = selectEvaluationClips(dataset);
  const analyzer = new FFmpegAudioAnalyzer();
  const results = [];
  for (const { source, gold, inputs } of clips) {
    const sourceIdentity = await hashStream(
      createReadStream(resolve(root, `${source.id}.${source.extension}`)),
    );
    if (sourceIdentity.sha256 !== source.sha256 || sourceIdentity.sizeBytes !== source.sizeBytes)
      throw new Error("Licensed source identity differs from manifest.");
    const evidence = source.producerEvidence.find((e) => e.type === "scoped_pcm");
    const filePath = resolve(root, `${source.id}-scoped-pcm.wav`);
    const identity = await hashStream(createReadStream(filePath));
    if (identity.sha256 !== evidence.sha256 || identity.sizeBytes !== evidence.sizeBytes)
      throw new Error("Scoped PCM identity differs from manifest.");
    const started = performance.now();
    const section = await analyzer.analyze({
      filePath,
      sourceSha256: source.sha256,
      inputSha256: identity.sha256,
      inputArtifactId: evidence.id,
      durationUs: BigInt(inputs.durationUs),
      scopeStartUs: BigInt(gold.scope.startUs),
      sourceDurationUs: BigInt(source.durationUs),
    });
    const predictions = section.data.silence.map((r) => ({
      startUs: r.startUs,
      endUs: r.endUs,
    }));
    const scoped = scopedMetricInputs(
      "silence_labels",
      gold,
      source,
      predictions,
      dataset.manifest.ownerDecision,
    );
    const processingWallTimeMs = performance.now() - started;
    results.push({
      sourceId: source.id,
      language: source.language,
      scope: gold.scope,
      provenance: inputs.provenance,
      scores: overlapScore(scoped.predictions, scoped.gold),
      processingWallTimeMs,
      realTimeFactor: processingWallTimeMs / (Number(inputs.durationUs) / 1000),
      analysis: section,
    });
  }
  const score = aggregate(results.map((r) => r.scores));
  return {
    datasetVersion: dataset.manifest.datasetVersion,
    ownerDecisionId: dataset.manifest.ownerDecision.id,
    metricPolicy:
      "Half-open integer-us duration overlap, approved scope intersection, no collar; pooled TP/FP/FN",
    configuration: {
      ...analyzer.configuration,
      minimumSilenceUs: String(analyzer.configuration.minimumSilenceUs),
      bucketUs: String(analyzer.configuration.bucketUs),
    },
    ...score,
    role: "PROJECT_GOLD_DIAGNOSTIC",
    projectGoldSemantics: "Owner-approved generated complement of Silero speech: NON_SPEECH",
    mediaAnalysisSchemaVersion: "1.1.0",
    PROJECT_GOLD_DIAGNOSTIC_F1: score.f1,
    CP2_STATUS: "NOT_MET",
    INDEPENDENT_HUMAN_ACCURACY: "NOT_PROVEN",
    INDEPENDENT_EVALUATION_STATUS:
      "NOT_PROVEN: Owner-approved generated Silero baseline, not human labels",
    clips: results,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--root")
      throw new Error("Usage: pnpm audio:evaluate --root LOCAL_DATASET_DIRECTORY");
    console.log(JSON.stringify(await evaluateAudio(resolve(process.argv[3])), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

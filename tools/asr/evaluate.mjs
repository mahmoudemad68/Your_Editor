/** Actual production ASR evaluation against the pinned US-110 project-gold authority. */
import process from "node:process";
import console from "node:console";
import { URL } from "node:url";
import { createReadStream, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runWorkerPython } from "./process.mjs";
import { loadDataset, validateDataset } from "../evaluation/validate.mjs";
import { scopedMetricInputs } from "../evaluation/scoped-inputs.mjs";
import { hashStream } from "../evaluation/storage.mjs";

export function selectWordClips(dataset, requireHuman = false) {
  const report = validateDataset(
    dataset.manifest,
    dataset.registry,
    dataset.documents,
    dataset.storageEvidence,
  );
  if (!report.DATASET_STRUCTURALLY_VALID) throw new Error("Evaluation provenance is invalid.");
  const clips = [];
  for (const source of dataset.manifest.sources) {
    const artifact = source.referenceArtifacts.find((a) => a.type === "word_alignment");
    if (!artifact) continue;
    const gold = dataset.documents.get(artifact.metadataPath).data;
    if (gold.review.status !== "approved") continue;
    const scoped = scopedMetricInputs(
      "word_alignment",
      gold,
      source,
      [],
      dataset.manifest.ownerDecision ?? null,
    );
    if (!requireHuman || scoped.provenance === "human_created")
      clips.push({ source, gold, scoped });
  }
  if (clips.length < 3)
    throw new Error(
      requireHuman
        ? "Independent human word gold is unavailable."
        : "Approved word gold is unavailable.",
    );
  return clips;
}

export async function evaluate(
  root,
  { requireHuman = false, repository = resolve(import.meta.dirname, "../..") } = {},
) {
  const dataset = loadDataset(repository),
    clips = selectWordClips(dataset, requireHuman);
  const temp = mkdtempSync(join(tmpdir(), "editagent-asr-evaluation-"));
  const results = [];
  try {
    for (const { source, gold, scoped } of clips) {
      console.error(JSON.stringify({ event: "asr.evaluation.clip", sourceId: source.id }));
      const original = await hashStream(
        createReadStream(resolve(root, `${source.id}.${source.extension}`)),
      );
      if (original.sha256 !== source.sha256 || original.sizeBytes !== source.sizeBytes)
        throw new Error("Source bytes differ from approved identity.");
      const evidence = source.producerEvidence?.find((e) => e.type === "scoped_pcm");
      if (!evidence) throw new Error("Approved scoped PCM identity unavailable.");
      const audio = resolve(root, `${source.id}-scoped-pcm.wav`);
      const checked = await hashStream(createReadStream(audio));
      if (checked.sha256 !== evidence.sha256 || checked.sizeBytes !== evidence.sizeBytes)
        throw new Error("Scoped audio identity differs.");
      const identity = join(temp, "identity.json");
      writeFileSync(
        identity,
        JSON.stringify({
          source_id: source.id,
          source_sha256: source.sha256,
          artifact_id: evidence.id,
          audio_sha256: evidence.sha256,
          source_duration_us: Number(source.durationUs),
          scope_start_us: Number(gold.scope.startUs),
          scope_end_us: Number(gold.scope.endUs),
        }),
      );
      const output = JSON.parse(
        await runWorkerPython("transcribe", ["--audio", audio, "--identity", identity], {
          env: {
            ...process.env,
            EDITAGENT_ASR_MODEL_ROOT:
              process.env.EDITAGENT_ASR_MODEL_ROOT ?? resolve(repository, ".local/asr-models"),
          },
        }),
      );
      if (output.section?.status !== "completed")
        throw new Error("Transcription did not produce complete validated word intervals.");
      const words = output.section.data.segments.flatMap((s) => s.words);
      const inputs = scopedMetricInputs(
        "word_alignment",
        gold,
        source,
        words,
        dataset.manifest.ownerDecision ?? null,
      );
      const scores = JSON.parse(
        await runWorkerPython("score_words", [], {
          input: JSON.stringify(inputs),
          timeoutMs: 30000,
          maxBytes: 1000000,
        }),
      );
      results.push({
        sourceId: source.id,
        language: source.language,
        detectedLanguage: output.section.data.language,
        scope: gold.scope,
        provenance: scoped.provenance,
        modelProvenance: output.section.provenance,
        inferenceParameters: output.inferenceParameters,
        wallTimeMs: output.wallTimeMs,
        peakRssBytes: output.peakRssBytes,
        wordCount: words.length,
        scores,
      });
    }
    const aggregate = {};
    for (const result of results) {
      const total = (aggregate[result.language] ??= {
        substitutions: 0,
        deletions: 0,
        insertions: 0,
        referenceWords: 0,
      });
      for (const key of Object.keys(total)) total[key] += result.scores[key];
    }
    for (const total of Object.values(aggregate))
      total.wer = total.referenceWords
        ? (total.substitutions + total.deletions + total.insertions) / total.referenceWords
        : null;
    const independent = results.every((r) => r.provenance === "human_created");
    return {
      datasetVersion: dataset.manifest.datasetVersion,
      ownerDecisionId: dataset.manifest.ownerDecision?.id ?? null,
      independentHumanAccuracy: independent ? "MEASURED" : "NOT_PROVEN",
      cp2Status: "NOT_MET",
      englishThreshold: 0.12,
      englishProjectGoldGate:
        aggregate.en?.wer != null
          ? aggregate.en.wer <= 0.12
            ? "PASS_UNDER_OWNER_APPROVED_PROJECT_GOLD"
            : "FAIL"
          : "NOT_PROVEN",
      results,
      aggregate,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const index = process.argv.indexOf("--root");
  if (index < 0 || !process.argv[index + 1])
    throw new Error("usage: asr:evaluate --root LOCAL_DATASET [--require-human-gold]");
  console.log(
    JSON.stringify(
      await evaluate(resolve(process.argv[index + 1]), {
        requireHuman: process.argv.includes("--require-human-gold"),
      }),
      null,
      2,
    ),
  );
}

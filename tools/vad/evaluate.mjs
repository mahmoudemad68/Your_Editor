/** Real production adapter evaluation; US-110 provenance validation remains authoritative. */
import { createReadStream, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, URL } from "node:url";
import { execFileSync } from "node:child_process";
import process from "node:process";
import console from "node:console";
import { loadDataset, validateDataset } from "../evaluation/validate.mjs";
import { scopedMetricInputs } from "../evaluation/scoped-inputs.mjs";
import { hashStream } from "../evaluation/storage.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export function aggregate(scores) {
  let tp = 0n,
    fp = 0n,
    fn = 0n;
  for (const score of scores) {
    tp += BigInt(score.tpUs);
    fp += BigInt(score.fpUs);
    fn += BigInt(score.fnUs);
  }
  return {
    tpUs: String(tp),
    fpUs: String(fp),
    fnUs: String(fn),
    precision: tp + fp ? Number(tp) / Number(tp + fp) : 1,
    recall: tp + fn ? Number(tp) / Number(tp + fn) : 1,
    f1: 2n * tp + fp + fn ? Number(2n * tp) / Number(2n * tp + fp + fn) : 1,
  };
}
export async function evaluate(mediaRoot, allowGenerated = false) {
  const dataset = loadDataset(repositoryRoot);
  const report = validateDataset(
    dataset.manifest,
    dataset.registry,
    dataset.documents,
    dataset.storageEvidence,
  );
  if (!report.DATASET_STRUCTURALLY_VALID) throw new Error("Evaluation dataset is invalid");
  const selected = [];
  for (const source of dataset.manifest.sources) {
    const artifact = source.referenceArtifacts.find((a) => a.type === "silence_labels");
    if (!artifact) continue;
    const gold = dataset.documents.get(artifact.metadataPath).data;
    if (gold.review.status !== "approved") continue;
    const inputs = scopedMetricInputs(
      "silence_labels",
      gold,
      source,
      [],
      dataset.manifest.ownerDecision ?? null,
    );
    selected.push({ source, artifact, gold, inputs });
  }
  const human = selected.filter((s) => s.inputs.provenance === "human_created");
  if (human.length < 3 && !allowGenerated)
    return {
      AC1: "NOT_PROVEN",
      BLOCKER: "EVALUATION_GOLD_UNAVAILABLE",
      datasetVersion: dataset.manifest.datasetVersion,
      approvedHumanClipCount: human.length,
      requiredHumanClipCount: 3,
      availableGeneratedArtifactIds: selected
        .filter((s) => s.inputs.provenance !== "human_created")
        .map((s) => s.artifact.id),
    };
  const clips = allowGenerated ? selected : human;
  if (clips.length < 3) throw new Error("At least three approved scoped clips are required");
  if (!mediaRoot)
    throw new Error("Evaluation requires --root with verified local source/scoped WAV files");
  const results = [];
  const directory = mkdtempSync(join(tmpdir(), "editagent-vad-evaluation-"));
  try {
    for (const { source, gold, inputs } of clips) {
      const sourcePath = resolve(mediaRoot, `${source.id}.${source.extension}`);
      const sourceIdentity = await hashStream(createReadStream(sourcePath));
      if (sourceIdentity.sha256 !== source.sha256 || sourceIdentity.sizeBytes !== source.sizeBytes)
        throw new Error("Licensed source bytes differ from manifest identity");
      const audioEvidence = source.producerEvidence?.find((e) => e.type === "scoped_pcm");
      // Human v2 gold may have a different scoped-audio mechanism; fail rather than invent identity.
      if (!audioEvidence)
        throw new Error("Scoped PCM identity unavailable; prepare manifest-bound audio evidence");
      const audioPath = resolve(mediaRoot, `${source.id}-scoped-pcm.wav`);
      const audioIdentity = await hashStream(createReadStream(audioPath));
      if (
        audioIdentity.sha256 !== audioEvidence.sha256 ||
        audioIdentity.sizeBytes !== audioEvidence.sizeBytes
      )
        throw new Error("Scoped PCM bytes differ from approved evidence identity");
      const identityPath = join(directory, "identity.json");
      const referencePath = join(directory, "reference.json");
      writeFileSync(
        identityPath,
        JSON.stringify({
          source_id: source.id,
          source_sha256: source.sha256,
          artifact_id: audioEvidence.id,
          audio_sha256: audioEvidence.sha256,
          source_duration_us: Number(source.durationUs),
          scope_start_us: Number(gold.scope.startUs),
          scope_end_us: Number(gold.scope.endUs),
        }),
      );
      writeFileSync(referencePath, JSON.stringify(inputs.gold));
      const output = JSON.parse(
        execFileSync(
          "uv",
          [
            "run",
            "--frozen",
            "--project",
            resolve(repositoryRoot, "workers/ai-worker"),
            "python",
            "-m",
            "editagent_ai_worker.composition.vad",
            "--audio",
            audioPath,
            "--identity",
            identityPath,
            "--reference",
            referencePath,
          ],
          { encoding: "utf8", timeout: 600_000, maxBuffer: 16_000_000 },
        ),
      );
      if (!output.analysis || !output.scores)
        throw new Error("Production adapter returned no validated analysis or scores");
      results.push({
        sourceId: source.id,
        language: source.language,
        scope: gold.scope,
        provenance: inputs.provenance,
        ownerDecisionId: dataset.manifest.ownerDecision?.id ?? null,
        audioDurationUs: inputs.durationUs,
        ...output,
        realTimeFactor: output.processingWallTimeMs / (Number(inputs.durationUs) / 1000),
      });
    }
    const independent = results.every((r) => r.provenance === "human_created");
    const speech = aggregate(results.map((r) => r.scores.speech));
    const silence = aggregate(results.map((r) => r.scores.silence));
    return {
      schemaVersion: 1,
      datasetVersion: dataset.manifest.datasetVersion,
      HUMAN_GOLD_CONFIRMED: independent,
      AC1: independent ? (speech.f1 >= 0.9 ? "PASS" : "FAIL") : "NOT_PROVEN",
      BLOCKER: independent ? null : "EVALUATION_GOLD_UNAVAILABLE",
      interpretation: independent
        ? "Independent duration-overlap evaluation"
        : "Agreement only with Owner-approved Silero-generated baseline; circular, no independent quality or CP2 pass",
      metricPolicy:
        "Half-open [start,end), integer-us intersections/unions inside approved scope; no collar; pool TP/FP/FN before ratios",
      speech,
      silence,
      clips: results,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const allowGenerated = args.includes("--allow-generated-baseline");
    const rest = args.filter((a) => a !== "--allow-generated-baseline");
    if (rest.length && (rest.length !== 2 || rest[0] !== "--root"))
      throw new Error("Usage: evaluate [--root DIRECTORY] [--allow-generated-baseline]");
    const result = await evaluate(rest[1], allowGenerated);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode =
      result.AC1 === "PASS" || (allowGenerated && result.clips?.length >= 3) ? 0 : 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

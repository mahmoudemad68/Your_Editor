import assert from "node:assert/strict";
import { readFileSync, copyFileSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import console from "node:console";
import {
  loadDataset,
  validateDataset,
  sha256,
  objectKey,
  assertDatasetMutable,
  repositoryRoot,
} from "./validate.mjs";
import { normalizedModelWords, silenceComplement } from "./annotations.mjs";
import { writeJson } from "./json.mjs";

// Verify existing bytes only. Never invoke inference, decode media or change approved gold.
export function verifyProducerBytes(source, words, silence, { pcm, rawBytes, generatedBytes }) {
  const raw = JSON.parse(rawBytes),
    generated = JSON.parse(generatedBytes);
  for (const doc of [words, silence]) {
    assert.equal(doc.sourceId, source.id);
    assert.equal(doc.sourceSha256, source.sha256);
    assert.equal(doc.generation.inputAudioSha256, sha256(pcm));
    assert.equal(doc.generation.rawOutputSha256, sha256(rawBytes));
  }
  assert.equal(generated.sourceId, source.id);
  assert.equal(generated.sourceSha256, source.sha256);
  assert.equal(generated.language, source.language);
  assert.equal(generated.scope.startUs, words.scope.startUs);
  assert.equal(generated.scope.endUs, words.scope.endUs);
  assert.deepEqual(generated.wordGeneration, words.generation);
  assert.deepEqual(generated.silenceGeneration, silence.generation);
  assert.deepEqual(generated.words, words.words);
  assert.deepEqual(generated.intervals, silence.intervals);
  assert.deepEqual(normalizedModelWords(raw.words, words.scope), words.words);
  assert.deepEqual(silenceComplement(raw.speechSamples, silence.scope), silence.intervals);
}

export async function archiveEvidence({ root, mediaRoot, dryRun = false }) {
  if (!root || !mediaRoot)
    throw new Error("Use --root exact-producer-directory --media-root staging-directory");
  const loaded = loadDataset(),
    { manifest, registry, documents } = loaded;
  assertDatasetMutable(manifest);
  let report = validateDataset(manifest, registry, documents, loaded.storageEvidence);
  if (!report.DATASET_STRUCTURALLY_VALID || !manifest.ownerDecision)
    throw new Error("Validate the current Owner-approved dataset before preserving evidence");
  const inputRoot = realpathSync(root),
    copies = [];
  for (const id of manifest.ownerDecision.acceptedSourceIds) {
    const source = manifest.sources.find((s) => s.id === id);
    const annotations = ["word_alignment", "silence_labels"].map((type) =>
      source.referenceArtifacts.find((a) => a.type === type),
    );
    const [words, silence] = annotations.map((a) => documents.get(a.metadataPath).data);
    const files = [
      { type: "scoped_pcm", name: `${id}.wav`, extension: "wav" },
      { type: "inference_raw", name: `${id}-raw.json`, extension: "json" },
      { type: "generation_output", name: `${id}-generated.json`, extension: "json" },
    ].map((f) => {
      const path = realpathSync(resolve(inputRoot, f.name));
      if (!path.startsWith(inputRoot + sep))
        throw new Error("Producer file leaves its input directory");
      return { ...f, path, bytes: readFileSync(path) };
    });
    verifyProducerBytes(source, words, silence, {
      pcm: files[0].bytes,
      rawBytes: files[1].bytes,
      generatedBytes: files[2].bytes,
    });
    source.producerEvidence = files.map((f) => {
      const item = {
        id: `${source.id}-${f.type.replaceAll("_", "-")}`,
        type: f.type,
        sourceId: source.id,
        sourceSha256: source.sha256,
        datasetVersion: manifest.datasetVersion,
        scope: { startUs: words.scope.startUs, endUs: words.scope.endUs },
        annotationIds: annotations.map((a) => a.id),
        sha256: sha256(f.bytes),
        sizeBytes: String(f.bytes.length),
        extension: f.extension,
      };
      item.objectKey = objectKey(manifest.datasetVersion, "producer-evidence", item);
      copies.push({ item, from: f.path, to: resolve(mediaRoot, `${item.id}.${item.extension}`) });
      return item;
    });
  }
  report = validateDataset(manifest, registry, documents, loaded.storageEvidence);
  if (!report.DATASET_STRUCTURALLY_VALID) throw new Error(report.errors.join("; "));
  if (!dryRun) {
    mkdirSync(mediaRoot, { recursive: true });
    for (const copy of copies) {
      copyFileSync(copy.from, copy.to);
      assert.equal(sha256(readFileSync(copy.to)), copy.item.sha256);
    }
    await writeJson(resolve(repositoryRoot, "docs/evaluation/manifest.json"), manifest);
  }
  // This prepares exact files; sync/deep perform versioned object upload/verification separately.
  return { exactEvidenceObjects: copies.length, staged: !dryRun, inferenceInvoked: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2),
      options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--dry-run") options.dryRun = true;
      else if (["--root", "--media-root"].includes(args[i]) && args[i + 1]) {
        options[args[i] === "--root" ? "root" : "mediaRoot"] = args[++i];
      } else throw new Error("Use --root DIR --media-root DIR [--dry-run]");
    }
    console.log(JSON.stringify(await archiveEvidence(options)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

import assert from "node:assert/strict";
import { createReadStream, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import console from "node:console";
import {
  loadDataset,
  repositoryRoot,
  validOwnerDecision,
  validateDocument,
  assertArtifactMutable,
  sha256,
} from "./validate.mjs";
import { hashStream } from "./storage.mjs";
import { refreshArtifact } from "./references.mjs";
import { writeJson } from "./json.mjs";

export function wordMicroseconds(value) {
  if (!Number.isFinite(value) || value < 0) throw new Error("Invalid model timestamp");
  let decimal = String(value);
  if (decimal.includes("e")) {
    const [coefficient, exponent] = decimal.split("e");
    const [whole, fractional = ""] = coefficient.split(".");
    const digits = whole + fractional,
      point = whole.length + Number(exponent);
    decimal =
      point <= 0
        ? `0.${"0".repeat(-point)}${digits}`
        : point >= digits.length
          ? digits.padEnd(point, "0")
          : `${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(decimal);
  if (!match) throw new Error("Unsupported model timestamp representation");
  const fraction = (match[2] || "").padEnd(7, "0");
  return (
    BigInt(match[1]) * 1000000n + BigInt(fraction.slice(0, 6)) + (fraction[6] >= "5" ? 1n : 0n)
  );
}
export function normalizedModelWords(raw, scope) {
  const lower = BigInt(scope.startUs),
    upper = BigInt(scope.endUs);
  let previous = lower;
  return raw.flatMap((word) => {
    const a = lower + wordMicroseconds(word.start),
      b = lower + wordMicroseconds(word.end);
    const start = a < lower ? lower : a,
      end = b > upper ? upper : b;
    if (start >= end || !word.text.trim()) return [];
    if (start < previous) throw new Error("Model word overlap cannot be silently repaired");
    previous = end;
    return [{ text: word.text.trim(), startUs: String(start), endUs: String(end) }];
  });
}
export function silenceComplement(speech, scope) {
  const lower = BigInt(scope.startUs),
    upper = BigInt(scope.endUs);
  const samples = ((upper - lower) * 16000n) / 1000000n;
  let previous = 0n;
  const intervals = [];
  for (const item of speech) {
    if (!Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end))
      throw new Error("Invalid VAD sample coordinates");
    const start = BigInt(item.start),
      end = BigInt(item.end);
    if (start < previous || start >= end || end > samples)
      throw new Error("Invalid VAD speech ranges");
    if (previous < start)
      intervals.push({
        startUs: String(lower + (previous * 1000000n) / 16000n),
        endUs: String(lower + (start * 1000000n) / 16000n),
      });
    previous = end;
  }
  if (previous < samples)
    intervals.push({
      startUs: String(lower + (previous * 1000000n) / 16000n),
      endUs: String(upper),
    });
  return intervals;
}
export async function importGenerated(mediaRoot, outputRoot) {
  const { manifest } = loadDataset();
  if (!mediaRoot || !outputRoot || !validOwnerDecision(manifest.ownerDecision))
    throw new Error("Recorded Owner deviation, --root and --output required");
  const changes = [];
  // Validate every source and raw inference/normalized result before modifying any annotation.
  for (const id of manifest.ownerDecision.acceptedSourceIds) {
    const source = manifest.sources.find((s) => s.id === id);
    const input = JSON.parse(readFileSync(resolve(outputRoot, `${id}-generated.json`), "utf8"));
    const rawPath = resolve(outputRoot, `${id}-raw.json`),
      rawBytes = readFileSync(rawPath);
    const raw = JSON.parse(rawBytes);
    const identity = await hashStream(
      createReadStream(resolve(mediaRoot, `${id}.${source.extension}`)),
    );
    assert.equal(identity.sha256, source.sha256);
    assert.equal(identity.sizeBytes, source.sizeBytes);
    assert.equal(input.sourceId, source.id);
    assert.equal(input.sourceSha256, source.sha256);
    assert.equal(input.language, source.language);
    assert.equal(input.scope.startUs, manifest.ownerDecision.scope.startUs);
    assert.equal(input.scope.endUs, manifest.ownerDecision.scope.endUs);
    assert.deepEqual(input.words, normalizedModelWords(raw.words, input.scope));
    assert.deepEqual(input.intervals, silenceComplement(raw.speechSamples, input.scope));
    const audioIdentity = await hashStream(createReadStream(resolve(outputRoot, `${id}.wav`)));
    for (const [type, field, provenance] of [
      ["word_alignment", "words", "wordGeneration"],
      ["silence_labels", "intervals", "silenceGeneration"],
    ]) {
      const artifact = source.referenceArtifacts.find((a) => a.type === type);
      const doc = JSON.parse(readFileSync(resolve(repositoryRoot, artifact.metadataPath), "utf8"));
      assertArtifactMutable(manifest, doc);
      assert.equal(
        input[provenance].generatorSha256,
        sha256(readFileSync(resolve(repositoryRoot, "tools/evaluation/generate.py"))),
      );
      assert.equal(input[provenance].inputAudioSha256, audioIdentity.sha256);
      assert.equal(input[provenance].rawOutputSha256, sha256(rawBytes));
      if (!input[field].length)
        throw new Error(`Empty generated ${type}; cannot satisfy the requested baseline`);
      Object.assign(doc, {
        createdBy: "machine_generated",
        generation: input[provenance],
        [field]: input[field],
        scope: { ...doc.scope, selection: "owner_confirmed" },
        annotationNotes:
          "Generated tool output, not manually hand-labelled. Scope accepted by the Owner's explicit US-110 deviation. Word timestamps use decimal half-up microseconds; VAD silence is the complement of speech sample ranges, floored to integer microseconds. Empty/zero-duration model words are omitted; raw inference identity is recorded. Final Owner acceptance is recorded separately in review evidence.",
      });
      validateDocument(type, doc, source, manifest.datasetVersion);
      changes.push({ artifact, doc });
    }
  }
  for (const { artifact, doc } of changes) await refreshArtifact(manifest, artifact, doc);
  await writeJson(resolve(repositoryRoot, "docs/evaluation/manifest.json"), manifest);
  console.log(
    `IMPORTED ${changes.length} generated annotations; provenance preserved; review still pending`,
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!["--root", "--output"].includes(args[i]) || !args[i + 1])
        throw new Error("Use --root media-dir --output inference-dir");
      options[args[i]] = args[i + 1];
    }
    await importGenerated(options["--root"], options["--output"]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

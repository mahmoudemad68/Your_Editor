import { createRequire } from "node:module";
import { readFileSync, realpathSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import console from "node:console";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(new URL("../../packages/job-queue/package.json", import.meta.url));
const Ajv = require("ajv/dist/2020.js");
const ajv = new Ajv({ strict: true, allErrors: true, strictRequired: false });
const schema = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "packages/schemas/src/evaluation-manifest.schema.json"),
    "utf8",
  ),
);
ajv.addSchema(schema);
const manifestValidator = ajv.getSchema(schema.$id);
const metricValidator = ajv.compile(
  JSON.parse(
    readFileSync(
      resolve(repositoryRoot, "packages/schemas/src/evaluation-metrics.schema.json"),
      "utf8",
    ),
  ),
);
const validators = Object.fromEntries(
  ["edit_spec", "silence_labels", "word_alignment", "render_receipt"].map((type) => [
    type,
    ajv.compile({ $ref: `${schema.$id}#/$defs/${type}` }),
  ]),
);
export const categories = [
  "podcast",
  "educational",
  "talking_head",
  "interview",
  "gaming",
  "technical_tutorial",
];
export const metricIds = [
  "caption_wer",
  "caption_sync_error",
  "silence_removal_accuracy",
  "content_retention",
  "render_success_rate",
  "editing_time",
  "human_acceptance_rate",
  "manual_corrections",
];
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Review bookkeeping never changes the editorial/annotation identity.
export function contentSha256(document) {
  const { review: _review, ...content } = document;
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])]),
      );
    return value;
  }
  return sha256(JSON.stringify(canonical(content)));
}
export function objectKey(version, group, item) {
  return `evaluation/${version}/${group}/${item.id}/${item.sha256}.${item.extension}`;
}
function roadmapStories(path) {
  const ids = new Set();
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) for (const id of roadmapStories(child)) ids.add(id);
    else if (entry.name.endsWith(".yaml"))
      for (const match of readFileSync(child, "utf8").matchAll(/\bUS-\d{3}\b/g)) ids.add(match[0]);
  }
  return ids;
}
const storyIds = roadmapStories(resolve(repositoryRoot, "docs/roadmap/backlog"));
function checkSchema(validate, value, label, errors) {
  if (!validate(value)) {
    errors.push(`${label}: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
    return false;
  }
  return true;
}
function unique(values, label, errors) {
  if (new Set(values).size !== values.length) errors.push(`Duplicate ${label}`);
}
function intervals(entries, duration, start, end, label, errors) {
  let previousEnd = 0n;
  for (const entry of entries) {
    const a = BigInt(entry[start]),
      b = BigInt(entry[end]);
    if (a >= b || b > duration) errors.push(`${label}: timestamp outside duration or empty range`);
    if (a < previousEnd) errors.push(`${label}: overlapping or out-of-order ranges`);
    previousEnd = b;
  }
}
export function validateDocument(type, doc, source, version) {
  const errors = [];
  if (!validators[type] || !checkSchema(validators[type], doc, type, errors))
    throw new Error(errors.join("; ") || "Unknown document type");
  if (
    doc.sourceId !== source.id ||
    doc.sourceSha256 !== source.sha256 ||
    doc.datasetVersion !== version
  )
    errors.push("Document source/version identity differs");
  const duration = BigInt(source.durationUs);
  if (type === "edit_spec") {
    intervals(doc.segments, duration, "sourceStartUs", "sourceEndUs", type, errors);
    let output = 0n;
    for (const segment of doc.segments) {
      if (BigInt(segment.outputStartUs) !== output)
        errors.push("Output segments must be contiguous from zero");
      output += BigInt(segment.sourceEndUs) - BigInt(segment.sourceStartUs);
    }
  }
  if (type === "silence_labels")
    intervals(doc.intervals, duration, "startUs", "endUs", type, errors);
  if (type === "word_alignment") {
    intervals(doc.words, duration, "startUs", "endUs", type, errors);
    if (doc.language !== source.language) errors.push("Annotation language differs");
  }
  if (errors.length) throw new Error(errors.join("; "));
}
export function validateDataset(manifest, registry, documents = new Map()) {
  const errors = [];
  const counts = {
    LICENSED_SOURCE_COUNT: 0,
    CATEGORY_COUNT: 0,
    APPROVED_HUMAN_REFERENCE_COUNT: 0,
    APPROVED_SILENCE_LABEL_COUNT: 0,
    APPROVED_WORD_ALIGNMENT_COUNT: 0,
  };
  const manifestOk = checkSchema(manifestValidator, manifest, "manifest", errors);
  const registryOk = checkSchema(metricValidator, registry, "metrics", errors);
  if (!manifestOk || !registryOk)
    return { DATASET_STRUCTURALLY_VALID: false, US110_GOLD_COMPLETE: false, ...counts, errors };
  if (manifest.datasetVersion !== registry.datasetVersion)
    errors.push("Metric registry dataset version differs");
  for (const metric of registry.metrics)
    if (!storyIds.has(metric.firstReportingStory))
      errors.push(`Unknown reporting story ${metric.firstReportingStory}`);
  unique(
    registry.metrics.map((m) => m.id),
    "metric ID",
    errors,
  );
  for (const id of metricIds)
    if (!registry.metrics.some((m) => m.id === id)) errors.push(`Missing metric ${id}`);
  unique(
    manifest.sources.map((s) => s.id),
    "source ID",
    errors,
  );
  unique(
    manifest.sources.map((s) => s.sha256),
    "source SHA-256",
    errors,
  );
  unique(
    manifest.sources.map((s) => s.source.url),
    "source URL",
    errors,
  );
  const prefix = `evaluation/${manifest.datasetVersion}/`;
  if (manifest.storage.prefix !== prefix)
    errors.push("Storage prefix differs from dataset version");
  const allArtifacts = manifest.sources.flatMap((s) => s.referenceArtifacts);
  unique(
    allArtifacts.map((a) => a.id),
    "artifact ID",
    errors,
  );
  unique(
    allArtifacts.map((a) => a.objectKey),
    "artifact object key",
    errors,
  );
  for (const category of categories)
    if (!manifest.sources.some((s) => s.category === category))
      errors.push(`Missing category ${category}`);
  for (const source of manifest.sources) {
    const duration = BigInt(source.durationUs);
    if (source.objectKey !== objectKey(manifest.datasetVersion, "sources", source))
      errors.push(`${source.id}: unsafe/noncanonical object key`);
    for (const uri of [
      source.source.url,
      source.source.downloadUrl,
      source.license.url,
      source.license.evidenceUrl,
    ]) {
      const parsed = new URL(uri);
      if (parsed.username || parsed.password || /(?:X-Amz-|token=|secret=|signature=)/i.test(uri))
        errors.push(`${source.id}: credential or signed URL forbidden`);
    }
    if (Number.isNaN(Date.parse(source.source.accessedAt)))
      errors.push(`${source.id}: invalid access date`);
    unique(
      source.referenceArtifacts.map((a) => a.type),
      "artifact variant type",
      errors,
    );
    const approved = new Set();
    const refs = new Map();
    for (const artifact of source.referenceArtifacts) {
      if (artifact.sourceId !== source.id || artifact.datasetVersion !== manifest.datasetVersion)
        errors.push(`${artifact.id}: invalid source/reference relation`);
      const group =
        artifact.type === "silence_labels" || artifact.type === "word_alignment"
          ? "annotations"
          : "references";
      if (artifact.objectKey !== objectKey(manifest.datasetVersion, group, artifact))
        errors.push(`${artifact.id}: unsafe/noncanonical object key`);
      if (artifact.type === "reference_reel") continue;
      const entry = documents.get(artifact.metadataPath);
      if (!entry) {
        errors.push(`${artifact.id}: metadata missing`);
        continue;
      }
      if (entry.sha256 !== artifact.sha256 || entry.sizeBytes !== artifact.sizeBytes)
        errors.push(`${artifact.id}: metadata checksum/size differs`);
      const doc = entry.data;
      if (!checkSchema(validators[artifact.type], doc, artifact.id, errors)) continue;
      refs.set(artifact.type, doc);
      if (
        doc.id !== artifact.id ||
        doc.sourceId !== source.id ||
        doc.sourceSha256 !== source.sha256 ||
        doc.datasetVersion !== manifest.datasetVersion
      )
        errors.push(`${artifact.id}: metadata identity differs`);
      if (artifact.type === "edit_spec") {
        intervals(doc.segments, duration, "sourceStartUs", "sourceEndUs", artifact.id, errors);
        let output = 0n;
        for (const segment of doc.segments) {
          if (BigInt(segment.outputStartUs) !== output)
            errors.push(`${artifact.id}: output segments must be contiguous from zero`);
          output += BigInt(segment.sourceEndUs) - BigInt(segment.sourceStartUs);
        }
      }
      if (artifact.type === "silence_labels")
        intervals(doc.intervals, duration, "startUs", "endUs", artifact.id, errors);
      if (artifact.type === "word_alignment") {
        intervals(doc.words, duration, "startUs", "endUs", artifact.id, errors);
        if (doc.language !== source.language)
          errors.push(`${artifact.id}: annotation language differs`);
      }
      if (doc.review?.evidence) {
        const evidence = doc.review.evidence;
        if (
          evidence.decision !== doc.review.status ||
          Number.isNaN(Date.parse(evidence.reviewedAt)) ||
          evidence.reviewedContentSha256 !== contentSha256(doc)
        )
          errors.push(`${artifact.id}: review evidence differs from content/decision`);
        if (doc.createdBy !== "human")
          errors.push(`${artifact.id}: machine-only content cannot be human gold`);
        if (doc.review.status === "approved" && doc.createdBy === "human")
          approved.add(artifact.type);
      }
    }
    const edit = refs.get("edit_spec"),
      receipt = refs.get("render_receipt");
    const reels = source.referenceArtifacts.filter((a) => a.type === "reference_reel");
    if (edit || receipt || reels.length) {
      if (!edit || !receipt || reels.length !== 1)
        errors.push(`${source.id}: reference requires one edit, receipt and reel`);
      else {
        const expectedDuration = edit.segments.reduce(
          (n, s) => n + BigInt(s.sourceEndUs) - BigInt(s.sourceStartUs),
          0n,
        );
        // H.264 duration is quantized to 30fps; allow one frame.
        const difference = BigInt(receipt.durationUs) - expectedDuration;
        if (
          receipt.editId !== edit.id ||
          receipt.editContentSha256 !== contentSha256(edit) ||
          receipt.artifactSha256 !== reels[0].sha256 ||
          receipt.durationUs !== reels[0].durationUs ||
          difference > 33334n ||
          difference < -33334n
        )
          errors.push(`${source.id}: reference render identity/duration differs`);
        if (approved.has("edit_spec")) {
          if (edit.review.evidence.renderSha256 !== receipt.artifactSha256)
            errors.push(`${source.id}: reviewed render differs`);
          else counts.APPROVED_HUMAN_REFERENCE_COUNT++;
        }
      }
    }
    if (approved.has("silence_labels") && refs.get("silence_labels").intervals.length)
      counts.APPROVED_SILENCE_LABEL_COUNT++;
    if (approved.has("word_alignment") && refs.get("word_alignment").words.length)
      counts.APPROVED_WORD_ALIGNMENT_COUNT++;
  }
  counts.LICENSED_SOURCE_COUNT = manifest.sources.length;
  counts.CATEGORY_COUNT = new Set(manifest.sources.map((s) => s.category)).size;
  const valid = errors.length === 0;
  return {
    DATASET_STRUCTURALLY_VALID: valid,
    US110_GOLD_COMPLETE:
      valid &&
      counts.APPROVED_HUMAN_REFERENCE_COUNT >= 6 &&
      counts.APPROVED_SILENCE_LABEL_COUNT >= 3 &&
      counts.APPROVED_WORD_ALIGNMENT_COUNT >= 3,
    ...counts,
    errors,
  };
}
export function loadDataset(root = repositoryRoot) {
  const manifest = JSON.parse(readFileSync(resolve(root, "docs/evaluation/manifest.json"), "utf8"));
  const registry = JSON.parse(readFileSync(resolve(root, "docs/evaluation/metrics.json"), "utf8"));
  if (!manifestValidator(manifest))
    throw new Error(`Invalid manifest: ${ajv.errorsText(manifestValidator.errors)}`);
  const documents = new Map();
  for (const item of manifest.sources.flatMap((s) => s.referenceArtifacts)) {
    if (!item.metadataPath) continue;
    const path = realpathSync(resolve(root, item.metadataPath));
    if (!path.startsWith(resolve(root, "docs/evaluation/artifacts") + sep))
      throw new Error("Metadata must remain inside evaluation artifacts");
    const bytes = readFileSync(path);
    if (bytes.length > 2_000_000) throw new Error("Metadata exceeds safe size limit");
    documents.set(item.metadataPath, {
      data: JSON.parse(bytes),
      sha256: sha256(bytes),
      sizeBytes: String(bytes.length),
    });
  }
  return { manifest, registry, documents };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== "--require-gold"))
      throw new Error("Unknown validation flag");
    const { manifest, registry, documents } = loadDataset();
    const report = validateDataset(manifest, registry, documents);
    if (report.DATASET_STRUCTURALLY_VALID) await (await import("./docs.mjs")).generateDocs(true);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode =
      !report.DATASET_STRUCTURALLY_VALID ||
      (process.argv.includes("--require-gold") && !report.US110_GOLD_COMPLETE)
        ? 1
        : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

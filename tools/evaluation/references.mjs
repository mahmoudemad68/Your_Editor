import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import process from "node:process";
import console from "node:console";
import { writeJson } from "./json.mjs";
export { writeJson, jsonBytes } from "./json.mjs";
import {
  loadDataset,
  repositoryRoot,
  sha256,
  contentSha256,
  objectKey,
  validateDocument,
  assertDatasetMutable,
  assertArtifactMutable,
  validOwnerDecision,
  assertOwnerBinding,
} from "./validate.mjs";
import { hashStream } from "./storage.mjs";
import { createReadStream } from "node:fs";

export function seconds(us) {
  const n = BigInt(us);
  return `${n / 1000000n}.${String(n % 1000000n).padStart(6, "0")}`;
}
export function execute(executable, args) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 2_000_000,
    shell: false,
  });
  if (result.error || result.status !== 0)
    throw new Error(`${executable} failed; untrusted decoder output withheld`);
  return result.stdout;
}
export function renderArguments(sourcePath, outputPath, edit, hasAudio) {
  const filters = [];
  for (const [i, segment] of edit.segments.entries()) {
    const range = `start=${seconds(segment.sourceStartUs)}:end=${seconds(segment.sourceEndUs)}`;
    filters.push(
      `[0:v:0]trim=${range},setpts=PTS-STARTPTS,scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v${i}]`,
    );
    if (hasAudio) filters.push(`[0:a:0]atrim=${range},asetpts=PTS-STARTPTS,aresample=48000[a${i}]`);
  }
  filters.push(
    edit.segments.map((_, i) => `[v${i}]${hasAudio ? `[a${i}]` : ""}`).join("") +
      `concat=n=${edit.segments.length}:v=1:a=${hasAudio ? 1 : 0}[video]${hasAudio ? "[audio]" : ""}`,
  );
  const duration = edit.segments.reduce(
    (n, s) => n + BigInt(s.sourceEndUs) - BigInt(s.sourceStartUs),
    0n,
  );
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-protocol_whitelist",
    "file",
    "-format_whitelist",
    "matroska,webm,ogg,mov,mp4,m4a,3gp,3g2,mj2",
    "-i",
    sourcePath,
    "-filter_complex_threads",
    "1",
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[video]",
    ...(hasAudio ? ["-map", "[audio]", "-c:a", "aac", "-b:a", "128k"] : ["-an"]),
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-preset",
    "medium",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-map_metadata",
    "-1",
    "-fflags",
    "+bitexact",
    "-flags:v",
    "+bitexact",
    "-movflags",
    "+faststart",
    "-t",
    seconds(duration),
    "-y",
    outputPath,
  ];
}
export async function refreshArtifact(manifest, artifact, data, root = repositoryRoot) {
  const bytes = await writeJson(resolve(root, artifact.metadataPath), data);
  artifact.sha256 = sha256(bytes);
  artifact.sizeBytes = String(Buffer.byteLength(bytes));
  artifact.objectKey = objectKey(
    manifest.datasetVersion,
    ["word_alignment", "silence_labels"].includes(artifact.type) ? "annotations" : "references",
    artifact,
  );
}
export async function renderReference(sourceId, root) {
  const { manifest } = loadDataset();
  assertDatasetMutable(manifest);
  const source = manifest.sources.find((s) => s.id === sourceId);
  if (!source || !root) throw new Error("Known source ID and --root media-directory required");
  const editArtifact = source.referenceArtifacts.find((a) => a.type === "edit_spec");
  if (!editArtifact) throw new Error("Source has no reference edit specification");
  const edit = JSON.parse(readFileSync(resolve(repositoryRoot, editArtifact.metadataPath), "utf8"));
  if (edit.id !== editArtifact.id) throw new Error("Edit ID differs from manifest");
  validateDocument("edit_spec", edit, source, manifest.datasetVersion);
  assertArtifactMutable(manifest, edit);
  const sourcePath = resolve(root, `${source.id}.${source.extension}`);
  const identity = await hashStream(createReadStream(sourcePath));
  if (identity.sha256 !== source.sha256 || identity.sizeBytes !== source.sizeBytes)
    throw new Error("Source checksum/size differs");
  const probe = JSON.parse(
    execute("ffprobe", [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      "matroska,webm,ogg,mov,mp4,m4a,3gp,3g2,mj2",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "json",
      sourcePath,
    ]),
  );
  if (!probe.streams.some((s) => s.codec_type === "video"))
    throw new Error("Source has no video stream");
  mkdirSync(root, { recursive: true });
  const reel = source.referenceArtifacts.find((a) => a.type === "reference_reel");
  const receiptArtifact = source.referenceArtifacts.find((a) => a.type === "render_receipt");
  if (!reel || !receiptArtifact) throw new Error("Reference artifact relation is incomplete");
  const temporary = resolve(root, `${reel.id}.${randomUUID()}.mp4`);
  try {
    execute(
      "ffmpeg",
      renderArguments(
        sourcePath,
        temporary,
        edit,
        probe.streams.some((s) => s.codec_type === "audio"),
      ),
    );
    const outputIdentity = await hashStream(createReadStream(temporary));
    const outputProbe = JSON.parse(
      execute("ffprobe", [
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        temporary,
      ]),
    );
    const duration = outputProbe.format.duration;
    if (!/^\d+\.\d{1,6}$/.test(duration)) throw new Error("Unexpected rendered duration");
    const [whole, fraction] = duration.split(".");
    const durationUs = String(BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0")));
    const receipt = {
      schemaVersion: "1.0",
      datasetVersion: manifest.datasetVersion,
      id: receiptArtifact.id,
      sourceId: source.id,
      sourceSha256: source.sha256,
      editId: edit.id,
      editContentSha256: contentSha256(edit),
      artifactSha256: outputIdentity.sha256,
      durationUs,
      tool: {
        ffmpegVersion: execute("ffmpeg", ["-version"]).split("\n")[0],
        ffprobeVersion: execute("ffprobe", ["-version"]).split("\n")[0],
        recipeVersion: "eval-reference-h264-v1",
      },
    };
    renameSync(temporary, resolve(root, `${reel.id}.mp4`));
    Object.assign(reel, outputIdentity, { durationUs });
    reel.objectKey = objectKey(manifest.datasetVersion, "references", reel);
    await refreshArtifact(manifest, editArtifact, edit);
    await refreshArtifact(manifest, receiptArtifact, receipt);
    await writeJson(resolve(repositoryRoot, "docs/evaluation/manifest.json"), manifest);
    console.log(`RENDERED ${reel.id} ${outputIdentity.sha256}`);
  } finally {
    rmSync(temporary, { force: true });
  }
}
export async function reviewArtifact(
  artifactId,
  { decision, reviewerId, notes, attestHuman, acceptGenerated = false, root, now = new Date() },
) {
  if (
    !attestHuman ||
    reviewerId !== "project-owner" ||
    !notes?.trim() ||
    !["approved", "rejected"].includes(decision)
  )
    throw new Error(
      "Review requires explicit human attestation, reviewer ID, notes and approved/rejected decision",
    );
  const { manifest } = loadDataset();
  assertDatasetMutable(manifest);
  const source = manifest.sources.find((s) =>
    s.referenceArtifacts.some((a) => a.id === artifactId),
  );
  const artifact = source?.referenceArtifacts.find((a) => a.id === artifactId);
  if (!artifact || !["edit_spec", "silence_labels", "word_alignment"].includes(artifact.type))
    throw new Error("Unknown reviewable artifact");
  const doc = JSON.parse(readFileSync(resolve(repositoryRoot, artifact.metadataPath), "utf8"));
  assertArtifactMutable(manifest, doc);
  if (doc.id !== artifact.id) throw new Error("Annotation/edit ID differs from manifest");
  const generated = doc.createdBy === "machine_generated";
  if (
    generated &&
    (!acceptGenerated ||
      !validOwnerDecision(manifest.ownerDecision) ||
      !manifest.ownerDecision.acceptedSourceIds.includes(source.id) ||
      doc.scope?.startUs !== manifest.ownerDecision.scope.startUs ||
      doc.scope?.endUs !== manifest.ownerDecision.scope.endUs ||
      reviewerId !== manifest.ownerDecision.reviewerId ||
      artifact.type === "edit_spec")
  )
    throw new Error(
      "Generated annotation approval requires the recorded Owner deviation and explicit --accept-generated-baseline",
    );
  if (acceptGenerated && !generated)
    throw new Error(
      "Generated acceptance flag cannot approve a human edit or an empty machine candidate",
    );
  if (doc.createdBy !== "human" && !generated)
    throw new Error(
      "Owner must record their editorial decisions/hand labels and set createdBy=human before review",
    );
  validateDocument(artifact.type, doc, source, manifest.datasetVersion);
  assertOwnerBinding(artifact.type, doc, source, manifest.datasetVersion, manifest.ownerDecision);
  if (
    decision === "approved" &&
    ((artifact.type === "silence_labels" && !doc.intervals.length) ||
      (artifact.type === "word_alignment" && !doc.words.length))
  )
    throw new Error("Empty annotation templates cannot be approved as labelled clips");
  if (decision === "approved" && doc.scope && doc.scope.selection !== "owner_confirmed")
    throw new Error("Owner must confirm or change the annotation scope before approval");
  const evidence = {
    reviewerId,
    reviewerRole: "project_owner",
    reviewedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    decision,
    humanAttestation: true,
    notes,
    reviewedContentSha256: contentSha256(doc),
    ...(generated
      ? { approvalBasis: "owner_accepted_generated", deviationId: manifest.ownerDecision.id }
      : {}),
  };
  if (artifact.type === "edit_spec") {
    const receiptArtifact = source.referenceArtifacts.find((a) => a.type === "render_receipt");
    const receipt = JSON.parse(
      readFileSync(resolve(repositoryRoot, receiptArtifact.metadataPath), "utf8"),
    );
    if (receipt.editContentSha256 !== evidence.reviewedContentSha256)
      throw new Error("Render the current human edit before reviewing");
    if (!root) throw new Error("Reference review requires --root to verify the reel you watched");
    const reel = source.referenceArtifacts.find((a) => a.type === "reference_reel");
    const actual = await hashStream(createReadStream(resolve(root, `${reel.id}.mp4`)));
    if (
      actual.sha256 !== receipt.artifactSha256 ||
      actual.sha256 !== reel.sha256 ||
      actual.sizeBytes !== reel.sizeBytes
    )
      throw new Error("Reviewed reel identity differs");
    evidence.renderSha256 = actual.sha256;
  }
  doc.review = { status: decision, evidence };
  await refreshArtifact(manifest, artifact, doc);
  await writeJson(resolve(repositoryRoot, "docs/evaluation/manifest.json"), manifest);
  console.log(`${decision.toUpperCase()} ${artifact.id}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, id, ...args] = process.argv.slice(2);
    const values = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--attest-human-review") {
        values.attestHuman = true;
        continue;
      }
      if (args[i] === "--accept-generated-baseline") {
        values.acceptGenerated = true;
        continue;
      }
      const keys = {
        "--root": "root",
        "--decision": "decision",
        "--reviewer": "reviewerId",
        "--notes": "notes",
      };
      if (!keys[args[i]] || !args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error("Invalid CLI arguments");
      values[keys[args[i]]] = args[++i];
    }
    if (command === "render") await renderReference(id, values.root);
    else if (command === "review") await reviewArtifact(id, values);
    else
      throw new Error(
        "Usage: references.mjs render SOURCE --root DIR | review ARTIFACT --decision approved|rejected --reviewer ID --notes TEXT --attest-human-review [--root DIR]",
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

import { createReadStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import process from "node:process";
import console from "node:console";
import { loadDataset, validateDocument } from "./validate.mjs";
import { execute, renderArguments, seconds } from "./references.mjs";
import { hashStream } from "./storage.mjs";

export function annotationEdit(scope) {
  return {
    segments: [{ sourceStartUs: scope.startUs, sourceEndUs: scope.endUs, outputStartUs: "0" }],
  };
}
export async function annotationClip(sourceId, mediaRoot) {
  if (!mediaRoot) throw new Error("annotation-clip requires --root local-media-directory");
  const { manifest, documents } = loadDataset();
  const source = manifest.sources.find((item) => item.id === sourceId);
  if (!source) throw new Error("Unknown source ID");
  const annotations = source.referenceArtifacts.filter((item) =>
    ["word_alignment", "silence_labels"].includes(item.type),
  );
  if (!annotations.length) throw new Error("Source has no annotation templates");
  const scopes = annotations.map((item) => {
    const doc = documents.get(item.metadataPath).data;
    validateDocument(item.type, doc, source, manifest.datasetVersion);
    return doc.scope;
  });
  if (scopes.some((scope) => JSON.stringify(scope) !== JSON.stringify(scopes[0])))
    throw new Error("Word and silence scopes differ; inspect and align the intended templates");
  const sourcePath = resolve(mediaRoot, `${source.id}.${source.extension}`);
  const actual = await hashStream(createReadStream(sourcePath));
  if (actual.sha256 !== source.sha256 || actual.sizeBytes !== source.sizeBytes)
    throw new Error("Local source checksum/size differs");
  const scope = scopes[0];
  const output = resolve(mediaRoot, `${source.id}-annotation-${scope.startUs}-${scope.endUs}.mp4`);
  if (existsSync(output))
    throw new Error(
      "Viewing clip exists; inspect it or remove only that local file before regenerating",
    );
  mkdirSync(resolve(mediaRoot), { recursive: true });
  const temporary = resolve(mediaRoot, `${randomUUID()}.mp4`);
  try {
    const probe = JSON.parse(
      execute("ffprobe", [
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "matroska,webm,ogg,mov,mp4,m4a,3gp,3g2,mj2",
        "-show_streams",
        "-of",
        "json",
        sourcePath,
      ]),
    );
    execute(
      "ffmpeg",
      renderArguments(
        sourcePath,
        temporary,
        annotationEdit(scope),
        probe.streams.some((stream) => stream.codec_type === "audio"),
      ),
    );
    renameSync(temporary, output);
    console.log(
      JSON.stringify(
        {
          sourceId,
          language: source.language,
          title: source.source.title,
          sourceDurationSeconds: seconds(source.durationUs),
          scope,
          scopeDurationSeconds: seconds(String(BigInt(scope.endUs) - BigInt(scope.startUs))),
          viewingClip: output,
          timestampRule:
            "Local playback starts at zero. Add scope.startUs to local times for SOURCE-coordinate labels.",
          status:
            scope.selection === "machine_candidate"
              ? "AWAITING_OWNER_SELECTION"
              : "Owner-confirmed scope; labels/review still required",
        },
        null,
        2,
      ),
    );
    return output;
  } finally {
    rmSync(temporary, { force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [sourceId, flag, root, ...extra] = process.argv.slice(2);
    if (!sourceId || flag !== "--root" || !root || extra.length)
      throw new Error("Usage: annotation-clip SOURCE_ID --root DIR");
    await annotationClip(sourceId, root);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

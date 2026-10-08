import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import console from "node:console";
import {
  loadDataset,
  repositoryRoot,
  objectKey,
  contentSha256,
  validateDataset,
} from "./validate.mjs";
import { refreshArtifact, writeJson } from "./references.mjs";
import { generateDocs } from "./docs.mjs";

export async function forkVersion(version, root = repositoryRoot) {
  const { manifest, registry, documents } = loadDataset(root);
  const report = validateDataset(manifest, registry, documents);
  if (!report.DATASET_STRUCTURALLY_VALID)
    throw new Error("Validate the current dataset before forking");
  if (
    !/^evaluation-dataset-v[1-9][0-9]*$/.test(version) ||
    BigInt(version.split("-v")[1]) <= BigInt(manifest.datasetVersion.split("-v")[1])
  )
    throw new Error("New version must be a strictly greater evaluation-dataset-vN");
  const archive = resolve(
    root,
    "docs/evaluation/releases",
    manifest.datasetVersion,
    "docs/evaluation",
  );
  if (existsSync(archive)) throw new Error("Historical archive already exists; refusing overwrite");
  mkdirSync(archive, { recursive: true });
  for (const name of [
    "manifest.json",
    "metrics.json",
    "METRICS.md",
    "DATASET_CARD.md",
    "README.md",
    "artifacts",
  ])
    cpSync(resolve(root, "docs/evaluation", name), resolve(archive, name), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  manifest.datasetVersion = version;
  manifest.storage.prefix = `evaluation/${version}/`;
  registry.datasetVersion = version;
  for (const source of manifest.sources) {
    source.objectKey = objectKey(version, "sources", source);
    const specs = new Map();
    for (const artifact of source.referenceArtifacts) {
      artifact.datasetVersion = version;
      if (artifact.type === "reference_reel") {
        artifact.objectKey = objectKey(version, "references", artifact);
        continue;
      }
      const doc = JSON.parse(readFileSync(resolve(root, artifact.metadataPath), "utf8"));
      doc.datasetVersion = version;
      if (doc.review) doc.review = { status: "awaiting_human_review" };
      specs.set(artifact.type, { artifact, doc });
    }
    const edit = specs.get("edit_spec"),
      receipt = specs.get("render_receipt");
    // Exact same reel bytes can be reused in the new snapshot; changed edits require rerender.
    if (edit && receipt) receipt.doc.editContentSha256 = contentSha256(edit.doc);
    for (const { artifact, doc } of specs.values())
      await refreshArtifact(manifest, artifact, doc, root);
  }
  await writeJson(resolve(root, "docs/evaluation/metrics.json"), registry);
  await writeJson(resolve(root, "docs/evaluation/manifest.json"), manifest);
  await generateDocs(false, root);
  console.log(
    `FORKED ${version}; previous snapshot archived; approvals cleared; sync to the new prefix before release`,
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await forkVersion(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

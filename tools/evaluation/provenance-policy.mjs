import { createHash } from "node:crypto";

// Reviewed code is the authority for this snapshot, not fields in mutable dataset JSON.
// A later version does not inherit this waiver. Changing these pins requires code review + QA.
export const v1Version = "evaluation-dataset-v1";
export const v1SourceIds = Object.freeze([
  "commons-28956463",
  "commons-98650286",
  "commons-82236797",
]);
export const v1DecisionSha256 = "dbebc609f78166625f88ccb4de3d25c52d595d677ab6438afa9ef0e41de4674f";
export const v1EvidenceSha256 = "deec0539eb0308cb05a2ea129e66fb7e104905877062f93357086885cee77eda";

// Object keys sorted recursively; array order retained. Includes the entire decision,
// including its six content/generation bindings and accepted SOURCE-coordinate scope.
export function policySha256(value) {
  function canonical(item) {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, canonical(item[key])]),
      );
    return item;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function assertV1OwnerDecision(version, decision) {
  if (version !== v1Version) return;
  if (!decision || policySha256(decision) !== v1DecisionSha256)
    throw new Error("Authoritative v1 provenance policy requires the exact pinned Owner decision");
}

export function assertV1Provenance(manifest) {
  if (manifest.datasetVersion !== v1Version) return;
  assertV1OwnerDecision(manifest.datasetVersion, manifest.ownerDecision);
  const evidence = [];
  for (const id of v1SourceIds) {
    const source = manifest.sources.find((item) => item.id === id);
    if (!source || source.producerEvidence?.length !== 3)
      throw new Error(
        "Authoritative v1 provenance policy requires nine producer evidence bindings",
      );
    evidence.push(...source.producerEvidence);
  }
  evidence.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (policySha256({ evidence }) !== v1EvidenceSha256)
    throw new Error("Authoritative v1 provenance policy producer evidence identity differs");
}

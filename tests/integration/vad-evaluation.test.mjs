import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregate,
  evaluate,
  acceptance,
  selectEvaluationClips,
} from "../../tools/vad/evaluate.mjs";

test("US-202 fails closed without independent human evaluation gold", async () => {
  const result = await evaluate(undefined, true);
  assert.equal(result.AC1, "NOT_PROVEN");
  assert.equal(result.BLOCKER, "EVALUATION_GOLD_UNAVAILABLE");
  assert.equal(result.approvedHumanClipCount, 0);
  assert.equal(result.availableGeneratedArtifactIds.length, 3);
  assert.equal(result.clips, undefined);
});
test("US-202 pools integer microsecond counts instead of averaging F1", () => {
  const pooled = aggregate([
    { tpUs: "50", fpUs: "50", fnUs: "50" },
    { tpUs: "100", fpUs: "0", fnUs: "0" },
  ]);
  assert.deepEqual(pooled, {
    tpUs: "150",
    fpUs: "50",
    fnUs: "50",
    precision: 0.75,
    recall: 0.75,
    f1: 0.75,
  });
  assert.equal(aggregate([]).f1, 1);
});

// Copies only: no approval records or pinned gold are written by these tests.
import { loadDataset, contentSha256, objectKey, sha256 } from "../../tools/evaluation/validate.mjs";
function fixture() {
  return globalThis.structuredClone(loadDataset());
}
function reindex(dataset) {
  for (const source of dataset.manifest.sources) {
    for (const artifact of source.referenceArtifacts) {
      if (!artifact.metadataPath) continue;
      const value = dataset.documents.get(artifact.metadataPath);
      const bytes = JSON.stringify(value.data);
      value.sha256 = artifact.sha256 = sha256(bytes);
      value.sizeBytes = artifact.sizeBytes = String(Buffer.byteLength(bytes));
      artifact.objectKey = objectKey(
        dataset.manifest.datasetVersion,
        ["silence_labels", "word_alignment"].includes(artifact.type) ? "annotations" : "references",
        artifact,
      );
    }
  }
}
test("US-202 defaults to the exact validated Owner-approved scoped project gold", () => {
  const { clips } = selectEvaluationClips(fixture());
  assert.equal(clips.length, 3);
  assert.deepEqual(clips.map((c) => c.source.language).sort(), ["ar", "en", "en"]);
  for (const clip of clips) {
    assert.equal(clip.inputs.provenance, "owner_approved_generated");
    assert.equal(clip.gold.createdBy, "machine_generated");
    assert.equal(clip.gold.scope.startUs, "30000000");
    assert.equal(clip.gold.scope.endUs, "90000000");
  }
});
for (const mutation of [
  "missing decision",
  "wrong decision",
  "changed scope",
  "changed labels",
  "wrong reviewer",
  "missing approval basis",
  "missing producer evidence",
  "human relabelling",
]) {
  test(`US-202 rejects invalid project-gold authority: ${mutation}`, () => {
    const dataset = fixture();
    const source = dataset.manifest.sources.find((s) => s.id === "commons-28956463");
    const artifact = source.referenceArtifacts.find((a) => a.type === "silence_labels");
    const gold = dataset.documents.get(artifact.metadataPath).data;
    if (mutation === "missing decision") delete dataset.manifest.ownerDecision;
    if (mutation === "wrong decision") dataset.manifest.ownerDecision.id = "unapproved";
    if (mutation === "changed scope") gold.scope.startUs = "31000000";
    if (mutation === "changed labels")
      gold.intervals[0].endUs = String(BigInt(gold.intervals[0].endUs) - 1n);
    if (mutation === "wrong reviewer") gold.review.evidence.reviewerId = "another-reviewer";
    if (mutation === "missing approval basis") delete gold.review.evidence.approvalBasis;
    if (mutation === "missing producer evidence") delete source.producerEvidence;
    if (mutation === "human relabelling") {
      gold.createdBy = "human";
      delete gold.generation;
    }
    gold.review.evidence.reviewedContentSha256 = contentSha256(gold);
    reindex(dataset); // Rejection must survive coherent mutable content/metadata checksums.
    assert.throws(() => selectEvaluationClips(dataset), /dataset\/provenance policy is invalid/);
    assert.throws(
      () => selectEvaluationClips(dataset, true),
      /dataset\/provenance policy is invalid/,
    );
  });
}
test("US-202 project speech acceptance is separate from human accuracy and CP2 silence", () => {
  const speech = aggregate([{ tpUs: "163948000", fpUs: "6572000", fnUs: "0" }]);
  const silence = aggregate([{ tpUs: "9480000", fpUs: "0", fnUs: "6572000" }]);
  const result = acceptance(speech, silence, false, "us110-owner-generated-annotation-gold-v1");
  assert.equal(result.AC1, "PASS_UNDER_OWNER_APPROVED_PROJECT_GOLD");
  assert.equal(result.PROJECT_GOLD_GATE, "PASS");
  assert.equal(result.HUMAN_CREATED_GOLD, false);
  assert.equal(result.HUMAN_GOLD_COMPLETE, false);
  assert.equal(result.HUMAN_GOLD_GATE, "NOT_AVAILABLE");
  assert.equal(result.INDEPENDENT_HUMAN_ACCURACY, "NOT_PROVEN");
  assert.equal(result.CP2_STATUS, "NOT_MET");
  assert.equal(
    acceptance({ ...speech, f1: 0.89 }, silence, false, result.OWNER_DECISION_ID).AC1,
    "FAIL",
  );
  assert.equal(
    acceptance(speech, { ...silence, f1: 1 }, false, result.OWNER_DECISION_ID).CP2_STATUS,
    "NOT_PROVEN",
  );
  assert.equal(acceptance(speech, silence, true, null).AC1, "PASS");
});

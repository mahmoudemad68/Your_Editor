import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  mkdirSync,
  cpSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  loadDataset,
  validateDataset,
  validateDocument,
  contentSha256,
  objectKey,
  sha256,
  repositoryRoot,
  datasetSha256,
  assertDatasetMutable,
  assertArtifactMutable,
} from "../../tools/evaluation/validate.mjs";
import { storageConfig, syncItem, verifyRemote } from "../../tools/evaluation/storage.mjs";
import { renderArguments, seconds } from "../../tools/evaluation/references.mjs";
import { forkVersion } from "../../tools/evaluation/version.mjs";
import { scopedMetricInputs } from "../../tools/evaluation/scoped-inputs.mjs";
import { annotationEdit } from "../../tools/evaluation/annotation-clip.mjs";
import { metricsMarkdown } from "../../tools/evaluation/docs.mjs";
import {
  normalizedModelWords,
  silenceComplement,
  wordMicroseconds,
} from "../../tools/evaluation/annotations.mjs";
import { verifyProducerBytes, stageEvidence } from "../../tools/evaluation/evidence.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
function fixture(actual = false) {
  const real = loadDataset();
  const data = {
    manifest: clone(real.manifest),
    registry: clone(real.registry),
    documents: new Map([...real.documents].map(([key, value]) => [key, clone(value)])),
  };
  if (!actual) {
    // Synthetic later-version fixtures exercise genuine human gold without the v1 waiver.
    data.manifest.datasetVersion = data.registry.datasetVersion = "evaluation-dataset-v2";
    data.manifest.storage.prefix = "evaluation/evaluation-dataset-v2/";
    for (const source of data.manifest.sources) {
      source.objectKey = objectKey(data.manifest.datasetVersion, "sources", source);
      for (const artifact of source.referenceArtifacts) {
        artifact.datasetVersion = data.manifest.datasetVersion;
        if (artifact.type === "reference_reel")
          artifact.objectKey = objectKey(data.manifest.datasetVersion, "references", artifact);
      }
    }
    for (const value of data.documents.values())
      value.data.datasetVersion = data.manifest.datasetVersion;
    delete data.manifest.ownerDecision;
    for (const source of data.manifest.sources) delete source.producerEvidence;
    for (const value of data.documents.values()) {
      const doc = value.data;
      if (doc.createdBy !== "machine_generated") continue;
      doc.createdBy = "machine_candidate";
      delete doc.generation;
      doc.review = { status: "awaiting_human_review" };
      doc.scope.selection = "machine_candidate";
      if (doc.words) doc.words = [];
      if (doc.intervals) doc.intervals = [];
    }
    for (const value of data.documents.values())
      if (value.data.review?.evidence)
        value.data.review.evidence.reviewedContentSha256 = contentSha256(value.data);
    for (const source of data.manifest.sources) {
      const edit = source.referenceArtifacts.find((a) => a.type === "edit_spec");
      const receipt = source.referenceArtifacts.find((a) => a.type === "render_receipt");
      if (edit && receipt)
        data.documents.get(receipt.metadataPath).data.editContentSha256 = contentSha256(
          data.documents.get(edit.metadataPath).data,
        );
    }
    reindex(data);
  }
  return data;
}
function report(data) {
  return validateDataset(data.manifest, data.registry, data.documents, data.storageEvidence);
}
function entry(data, type, index = 0) {
  const source = data.manifest.sources.filter((s) =>
    s.referenceArtifacts.some((a) => a.type === type),
  )[index];
  const artifact = source.referenceArtifacts.find((a) => a.type === type);
  return { source, artifact, doc: data.documents.get(artifact.metadataPath)?.data };
}
function reindex(data) {
  for (const source of data.manifest.sources)
    for (const artifact of source.referenceArtifacts) {
      if (!artifact.metadataPath) continue;
      const value = data.documents.get(artifact.metadataPath);
      const bytes = JSON.stringify(value.data);
      value.sha256 = artifact.sha256 = sha256(bytes);
      value.sizeBytes = artifact.sizeBytes = String(Buffer.byteLength(bytes));
      artifact.objectKey = objectKey(
        data.manifest.datasetVersion,
        ["silence_labels", "word_alignment"].includes(artifact.type) ? "annotations" : "references",
        artifact,
      );
    }
}
function approve(doc, renderSha256) {
  // Synthetic test evidence ONLY; never applied to the real dataset.
  doc.createdBy = "human";
  delete doc.generation;
  if (doc.scope) doc.scope.selection = "owner_confirmed";
  doc.review = {
    status: "approved",
    evidence: {
      reviewerId: "project-owner",
      reviewerRole: "project_owner",
      reviewedAt: "2026-10-08T00:00:00Z",
      decision: "approved",
      humanAttestation: true,
      notes: "Synthetic test fixture; not a real human review",
      reviewedContentSha256: contentSha256(doc),
      ...(renderSha256 ? { renderSha256 } : {}),
    },
  };
}
function goldFixture() {
  const data = fixture();
  for (const source of data.manifest.sources) {
    const editArtifact = source.referenceArtifacts.find((a) => a.type === "edit_spec");
    if (!editArtifact) continue;
    const edit = data.documents.get(editArtifact.metadataPath).data;
    const receiptArtifact = source.referenceArtifacts.find((a) => a.type === "render_receipt");
    const receipt = data.documents.get(receiptArtifact.metadataPath).data;
    approve(edit, receipt.artifactSha256);
    receipt.editContentSha256 = contentSha256(edit);
    for (const artifact of source.referenceArtifacts) {
      const doc = data.documents.get(artifact.metadataPath)?.data;
      if (artifact.type === "silence_labels") {
        doc.intervals = [
          { startUs: doc.scope.startUs, endUs: String(BigInt(doc.scope.startUs) + 1000000n) },
        ];
        approve(doc);
      }
      if (artifact.type === "word_alignment") {
        doc.words = [
          {
            text: source.language === "ar" ? "مرحباً،" : "Hello,",
            startUs: String(BigInt(doc.scope.startUs) + 1000000n),
            endUs: String(BigInt(doc.scope.startUs) + 2000000n),
          },
        ];
        approve(doc);
      }
    }
  }
  reindex(data);
  return data;
}
test("actual manifest meets Owner-approved gold under the explicit deviation; human creation and durable release remain incomplete", () => {
  const r = report(fixture(true));
  assert.equal(r.DATASET_STRUCTURALLY_VALID, true, r.errors.join(";"));
  assert.equal(r.US110_GOLD_COMPLETE, true);
  assert.equal(r.LICENSED_SOURCE_COUNT, 12);
  assert.equal(r.CATEGORY_COUNT, 6);
  assert.equal(r.APPROVED_HUMAN_REFERENCE_COUNT, 6);
  assert.equal(r.APPROVED_SILENCE_LABEL_COUNT, 0);
  assert.equal(r.APPROVED_WORD_ALIGNMENT_COUNT, 0);
  assert.equal(r.HUMAN_GOLD_COMPLETE, false);
  assert.equal(r.GOLD_STORAGE_DURABLE, false);
  assert.equal(r.OWNER_APPROVED_SILENCE_LABEL_COUNT, 3);
  assert.equal(r.OWNER_APPROVED_WORD_ALIGNMENT_COUNT, 3);
  assert.equal(r.OWNER_APPROVED_GOLD, true);
  assert.equal(r.HUMAN_CREATED_GOLD, false);
  assert.equal(r.US110_RELEASE_COMPLETE, false);
});
test("synthetic genuine-human-shaped evidence satisfies unchanged 6/3/3 quota", () => {
  const r = report(goldFixture());
  assert.equal(r.DATASET_STRUCTURALLY_VALID, true, r.errors.join(";"));
  assert.equal(r.HUMAN_GOLD_COMPLETE, true);
  assert.equal(r.US110_GOLD_COMPLETE, false);
  assert.equal(r.GOLD_STORAGE_DURABLE, false);
  assert.equal(r.APPROVED_HUMAN_REFERENCE_COUNT, 6);
  assert.equal(r.APPROVED_SILENCE_LABEL_COUNT, 3);
  assert.equal(r.APPROVED_WORD_ALIGNMENT_COUNT, 3);
});
const mutations = {
  "duplicate source ID": (d) => {
    d.manifest.sources[1].id = d.manifest.sources[0].id;
  },
  "duplicate source hash": (d) => {
    d.manifest.sources[1].sha256 = d.manifest.sources[0].sha256;
  },
  "duplicate published source URL": (d) => {
    d.manifest.sources[1].source.url = d.manifest.sources[0].source.url;
  },
  "missing category": (d) => {
    for (const s of d.manifest.sources) if (s.category === "gaming") s.category = "educational";
  },
  "fewer than twelve sources": (d) => {
    d.manifest.sources.pop();
  },
  "invalid hash": (d) => {
    d.manifest.sources[0].sha256 = "not-sha256";
  },
  "missing license identifier": (d) => {
    delete d.manifest.sources[0].license.id;
  },
  "unknown license": (d) => {
    d.manifest.sources[0].license.id = "unknown";
  },
  "missing public license URL": (d) => {
    delete d.manifest.sources[0].license.url;
  },
  "missing source URL": (d) => {
    delete d.manifest.sources[0].source.url;
  },
  "private consent missing evidence": (d) => {
    d.manifest.sources[0].license.id = "LicenseRef-Private-Consent";
  },
  "invalid source/reference link": (d) => {
    entry(d, "edit_spec").artifact.sourceId = d.manifest.sources[1].id;
  },
  "wrong version": (d) => {
    entry(d, "edit_spec").artifact.datasetVersion = "evaluation-dataset-v3";
  },
  "invalid duration": (d) => {
    d.manifest.sources[0].durationUs = "1.5";
  },
  "numeric duration loses explicit integer contract": (d) => {
    d.manifest.sources[0].durationUs = 1000000;
  },
  "zero duration": (d) => {
    d.manifest.sources[0].durationUs = "0";
  },
  "unknown category": (d) => {
    d.manifest.sources[0].category = "news";
  },
  "unknown artifact type": (d) => {
    entry(d, "edit_spec").artifact.type = "random_file";
  },
  "unknown manifest field": (d) => {
    d.manifest.originalStorageKey = "private-key";
  },
  "unknown artifact field": (d) => {
    entry(d, "edit_spec").artifact.url = "https://example.com/secret";
  },
  "path traversal in metadata": (d) => {
    entry(d, "edit_spec").artifact.metadataPath = "../secret.json";
  },
  "unsafe object key": (d) => {
    d.manifest.sources[0].objectKey = "other-project/original.mp4";
  },
  "signed URL in provenance": (d) => {
    d.manifest.sources[0].source.downloadUrl += "?X-Amz-Signature=abc";
  },
  "credentials in source URL": (d) => {
    d.manifest.sources[0].source.url = "https://user:password@example.com/file";
  },
  "missing formula": (d) => {
    delete d.registry.metrics[0].formula;
  },
  "missing unit": (d) => {
    delete d.registry.metrics[0].unit;
  },
  "missing first reporting story": (d) => {
    delete d.registry.metrics[0].firstReportingStory;
  },
  "unknown metric": (d) => {
    d.registry.metrics[0].id = "subjective_magic";
  },
  "duplicate metric": (d) => {
    d.registry.metrics[1] = clone(d.registry.metrics[0]);
  },
  "registry version differs": (d) => {
    d.registry.datasetVersion = "evaluation-dataset-v3";
  },
};
for (const [name, mutate] of Object.entries(mutations))
  test(`rejects ${name}`, () => {
    const data = fixture();
    mutate(data);
    const r = report(data);
    assert.equal(r.DATASET_STRUCTURALLY_VALID, false, JSON.stringify(r));
    assert.equal(r.US110_GOLD_COMPLETE, false);
  });
const documentMutations = {
  "negative timestamp": (d) => {
    entry(d, "edit_spec").doc.segments[0].sourceStartUs = "-1";
  },
  "floating timestamp": (d) => {
    entry(d, "edit_spec").doc.segments[0].sourceStartUs = "0.2";
  },
  "empty range": (d) => {
    entry(d, "edit_spec").doc.segments[0].sourceEndUs = "0";
  },
  "annotation outside duration": (d) => {
    const { source, doc } = entry(d, "silence_labels");
    doc.intervals = [{ startUs: "0", endUs: String(BigInt(source.durationUs) + 1n) }];
  },
  "overlapping silence": (d) => {
    entry(d, "silence_labels").doc.intervals = [
      { startUs: "0", endUs: "2000" },
      { startUs: "1000", endUs: "3000" },
    ];
  },
  "out-of-order words": (d) => {
    entry(d, "word_alignment").doc.words = [
      { text: "two", startUs: "2000", endUs: "3000" },
      { text: "one", startUs: "0", endUs: "1000" },
    ];
  },
  "unknown annotation fields": (d) => {
    entry(d, "word_alignment").doc.rawJobPayload = "unsafe";
  },
  "source hash differs": (d) => {
    entry(d, "word_alignment").doc.sourceSha256 = "f".repeat(64);
  },
  "output gap": (d) => {
    entry(d, "edit_spec").doc.segments[0].outputStartUs = "1000";
  },
  "stale edit/render relation": (d) => {
    entry(d, "edit_spec").doc.decisionNotes = "Changed without rendering";
  },
  "missing metadata": (d) => {
    d.documents.delete(entry(d, "word_alignment").artifact.metadataPath);
  },
};
for (const [name, mutate] of Object.entries(documentMutations))
  test(`rejects ${name}`, () => {
    const data = fixture();
    mutate(data);
    if (name !== "missing metadata") reindex(data);
    const r = report(data);
    assert.equal(r.DATASET_STRUCTURALLY_VALID, false, r.errors.join(";"));
  });
test("metadata checksum and byte size are independently enforced", () => {
  const data = fixture();
  entry(data, "silence_labels").doc.annotationNotes = "Unindexed mutation";
  // The caller supplies actual byte identity; a stale manifest must fail.
  const item = entry(data, "silence_labels");
  const bytes = JSON.stringify(item.doc);
  data.documents.set(item.artifact.metadataPath, {
    data: item.doc,
    sha256: sha256(bytes),
    sizeBytes: String(bytes.length),
  });
  assert.equal(report(data).DATASET_STRUCTURALLY_VALID, false);
});
test("machine-only approved edit cannot count as human gold", () => {
  const data = goldFixture();
  const { doc } = entry(data, "edit_spec");
  doc.createdBy = "machine_candidate";
  doc.review.evidence.reviewedContentSha256 = contentSha256(doc);
  reindex(data);
  const r = report(data);
  assert.equal(r.DATASET_STRUCTURALLY_VALID, false);
  assert.equal(r.US110_GOLD_COMPLETE, false);
  assert.equal(r.APPROVED_HUMAN_REFERENCE_COUNT, 5);
});
test("unapproved annotations and empty templates do not count", () => {
  const data = goldFixture();
  for (const type of ["silence_labels", "word_alignment"]) {
    const { doc } = entry(data, type);
    doc.review = { status: "awaiting_human_review" };
  }
  reindex(data);
  const r = report(data);
  assert.equal(r.DATASET_STRUCTURALLY_VALID, true);
  assert.equal(r.US110_GOLD_COMPLETE, false);
  assert.equal(r.APPROVED_SILENCE_LABEL_COUNT, 2);
  assert.equal(r.APPROVED_WORD_ALIGNMENT_COUNT, 2);
});
test("approval fingerprint catches later gold edits", () => {
  const data = goldFixture();
  entry(data, "word_alignment").doc.words[0].text = "Changed";
  reindex(data);
  assert.equal(report(data).DATASET_STRUCTURALLY_VALID, false);
});
test("review must include real-shaped evidence and exact rendered SHA", () => {
  const data = goldFixture();
  entry(data, "edit_spec").doc.review.evidence.renderSha256 = "f".repeat(64);
  reindex(data);
  assert.equal(report(data).DATASET_STRUCTURALLY_VALID, false);
  delete entry(data, "word_alignment").doc.review.evidence;
  reindex(data);
  assert.equal(report(data).DATASET_STRUCTURALLY_VALID, false);
});
test("Arabic word text survives validation without gold normalization", () => {
  const data = goldFixture();
  const source = data.manifest.sources.find(
    (s) => s.language === "ar" && s.referenceArtifacts.some((a) => a.type === "word_alignment"),
  );
  const artifact = source.referenceArtifacts.find((a) => a.type === "word_alignment");
  assert.equal(data.documents.get(artifact.metadataPath).data.words[0].text, "مرحباً،");
  assert.equal(report(data).DATASET_STRUCTURALLY_VALID, true);
});
test("microsecond conversion does not use unsafe Number arithmetic", () => {
  assert.equal(seconds("9007199254740993001"), "9007199254740.993001");
  assert.equal(seconds("1"), "0.000001");
});
test("renderer uses local protocols, approved formats and literal argument paths", () => {
  const edit = entry(fixture(), "edit_spec").doc;
  const args = renderArguments(
    "/tmp/source;touch BAD.webm",
    "/tmp/output with spaces.mp4",
    edit,
    true,
  );
  assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "file");
  assert.ok(args.includes("-format_whitelist"));
  assert.ok(args.includes("/tmp/source;touch BAD.webm"));
  assert.ok(args.includes("[audio]"));
  assert.equal(args.at(-1), "/tmp/output with spaces.mp4");
  assert.ok(renderArguments("a", "b", edit, false).includes("-an"));
});
test("render/review document validator refuses out-of-bounds edits before decoding", () => {
  const { source, doc } = entry(fixture(), "edit_spec");
  doc.segments[0].sourceEndUs = String(BigInt(source.durationUs) + 1n);
  assert.throws(
    () => validateDocument("edit_spec", doc, source, "evaluation-dataset-v1"),
    /timestamp/,
  );
});
test("metric prose is generated from the canonical registry without drift", async () => {
  const data = fixture(true);
  assert.equal(
    await metricsMarkdown(data.registry),
    readFileSync(resolve(repositoryRoot, "docs/evaluation/METRICS.md"), "utf8"),
  );
});
test("project gold CLI accepts the Owner decision while original human and durable release gates fail", () => {
  for (const [args, expected] of [
    [[], 0],
    [["--require-gold"], 0],
    [["--require-human-gold"], 1],
    [["--require-release"], 1],
  ]) {
    const r = spawnSync(process.execPath, ["tools/evaluation/validate.mjs", ...args], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.equal(r.status, expected, r.stderr);
    assert.match(r.stdout, /"US110_GOLD_COMPLETE": true/);
    assert.match(r.stdout, /"HUMAN_CREATED_GOLD": false/);
    assert.match(r.stdout, /"US110_RELEASE_COMPLETE": false/);
  }
});
const config = {
  EVALUATION_S3_ENDPOINT: "http://127.0.0.1:9001",
  EVALUATION_S3_BUCKET: "test-evaluation",
  EVALUATION_S3_ACCESS_KEY_ID: "synthetic-test-key",
  EVALUATION_S3_SECRET_ACCESS_KEY: "synthetic-not-a-credential",
};
test("storage configuration fails closed without secrets and remote TLS", () => {
  assert.throws(() => storageConfig({}, "test-evaluation"), /Missing/);
  assert.throws(() => storageConfig(config, "other-bucket"), /differs/);
  for (const endpoint of [
    "http://remote.example",
    "https://user:pass@example.com",
    "https://example.com?token=secret",
  ])
    assert.throws(() =>
      storageConfig({ ...config, EVALUATION_S3_ENDPOINT: endpoint }, "test-evaluation"),
    );
  assert.equal(storageConfig(config, "test-evaluation").forcePathStyle, true);
});
test("sync verifies bytes, conditional writes and exact idempotent reuse", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "us110-sync-test-"));
  const file = resolve(dir, "fixture.json");
  const bytes = Buffer.from("fixture bytes");
  writeFileSync(file, bytes);
  const item = {
    id: "test-source",
    objectKey: "evaluation/evaluation-dataset-v1/sources/test-source/hash.json",
    extension: "json",
    sha256: sha256(bytes),
    sizeBytes: String(bytes.length),
  };
  let exists = false;
  const calls = [];
  const client = {
    async send(command) {
      calls.push(command);
      if (command.constructor.name === "HeadObjectCommand" && !exists)
        throw Object.assign(new Error("synthetic missing"), { $metadata: { httpStatusCode: 404 } });
      if (command.constructor.name === "PutObjectCommand") {
        exists = true;
        assert.equal(command.input.IfNoneMatch, "*");
      }
      if (command.constructor.name === "GetObjectCommand")
        return { Body: Readable.from([bytes]), VersionId: "synthetic-version" };
      return {};
    },
  };
  try {
    assert.equal(await syncItem(client, "test-evaluation", item, file), "UPLOADED");
    assert.equal(await syncItem(client, "test-evaluation", item, file), "REUSED");
    assert.equal(calls.filter((c) => c.constructor.name === "PutObjectCommand").length, 1);
    await assert.rejects(
      () =>
        verifyRemote(
          {
            send: async () => ({ Body: Readable.from([Buffer.from("different")]), VersionId: "v" }),
          },
          "test-evaluation",
          item,
        ),
      /differs/,
    );
    await assert.rejects(
      () =>
        verifyRemote(
          { send: async () => ({ Body: Readable.from([bytes]), VersionId: "null" }) },
          "test-evaluation",
          item,
        ),
      /not versioned/,
    );
    const corruptClient = {
      send: async (command) =>
        command.constructor.name === "GetObjectCommand"
          ? { Body: Readable.from([Buffer.from("different")]), VersionId: "v" }
          : {},
    };
    await assert.rejects(() => syncItem(corruptClient, "test-evaluation", item, file), /differs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("version fork archives historical metadata and resets approval bookkeeping", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "us110-version-test-"));
  mkdirSync(resolve(root, "docs"));
  cpSync(resolve(repositoryRoot, "docs/evaluation"), resolve(root, "docs/evaluation"), {
    recursive: true,
  });
  try {
    await forkVersion("evaluation-dataset-v2", root);
    const current = loadDataset(root);
    assert.equal(current.manifest.datasetVersion, "evaluation-dataset-v2");
    assert.equal(current.manifest.ownerDecision, undefined);
    assert.ok(current.manifest.sources.every((source) => !source.producerEvidence));
    for (const entry of current.documents.values())
      if (entry.data.createdBy === "machine_generated") {
        assert.ok(entry.data.generation);
        assert.equal(entry.data.review.status, "awaiting_human_review");
        assert.equal(entry.data.review.evidence, undefined);
      }
    assert.equal(report(current).DATASET_STRUCTURALLY_VALID, true);
    const archive = loadDataset(resolve(root, "docs/evaluation/releases/evaluation-dataset-v1"));
    assert.equal(archive.manifest.datasetVersion, "evaluation-dataset-v1");
    assert.equal(report(archive).DATASET_STRUCTURALLY_VALID, true);
    await assert.rejects(() => forkVersion("evaluation-dataset-v2", root), /strictly greater/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("unknown roadmap reporting story and empty formulas are rejected", () => {
  const data = fixture();
  data.registry.metrics[0].firstReportingStory = "US-999";
  assert.equal(report(data).DATASET_STRUCTURALLY_VALID, false);
  data.registry.metrics[0].firstReportingStory = "US-201";
  data.registry.metrics[0].formula = "  ";
  assert.equal(report(data).DATASET_STRUCTURALLY_VALID, false);
});

test("reference reel duration must match its render receipt", () => {
  const data = fixture();
  entry(data, "reference_reel").artifact.durationUs = "1";
  assert.equal(report(data).DATASET_STRUCTURALLY_VALID, false);
});

for (const type of ["silence_labels", "word_alignment"]) {
  test(`valid scoped ${type} counts only current human-approved gold`, () => {
    const data = goldFixture();
    const { source, doc } = entry(data, type);
    assert.doesNotThrow(() => validateDocument(type, doc, source, data.manifest.datasetVersion));
    assert.equal(report(data).DATASET_STRUCTURALLY_VALID, true);
    doc.review = { status: "awaiting_human_review" };
    reindex(data);
    assert.equal(
      report(data)[
        type === "silence_labels" ? "APPROVED_SILENCE_LABEL_COUNT" : "APPROVED_WORD_ALIGNMENT_COUNT"
      ],
      2,
    );
    doc.createdBy = "machine_candidate";
    doc.scope.selection = "machine_candidate";
    reindex(data);
    assert.equal(report(data).DATASET_STRUCTURALLY_VALID, true);
  });
  test(`empty approved ${type} fails and cannot count`, () => {
    const data = goldFixture();
    const { doc } = entry(data, type);
    doc[type === "silence_labels" ? "intervals" : "words"] = [];
    approve(doc);
    reindex(data);
    assert.equal(report(data).DATASET_STRUCTURALLY_VALID, false);
    assert.equal(
      report(data)[
        type === "silence_labels" ? "APPROVED_SILENCE_LABEL_COUNT" : "APPROVED_WORD_ALIGNMENT_COUNT"
      ],
      2,
    );
  });
  test(`machine or unconfirmed ${type} cannot become approved gold`, () => {
    const data = goldFixture();
    const { doc } = entry(data, type);
    doc.scope.selection = "machine_candidate";
    doc.review.evidence.reviewedContentSha256 = contentSha256(doc);
    reindex(data);
    assert.equal(report(data).DATASET_STRUCTURALLY_VALID, false);
    assert.equal(
      report(data)[
        type === "silence_labels" ? "APPROVED_SILENCE_LABEL_COUNT" : "APPROVED_WORD_ALIGNMENT_COUNT"
      ],
      2,
    );
    doc.createdBy = "machine_candidate";
    doc.review.evidence.reviewedContentSha256 = contentSha256(doc);
    reindex(data);
    assert.equal(report(data).DATASET_STRUCTURALLY_VALID, false);
  });
}
const scopeMutations = {
  "scope outside source": (doc, source) => {
    doc.scope.endUs = String(BigInt(source.durationUs) + 1n);
  },
  "empty scope": (doc) => {
    doc.scope.endUs = doc.scope.startUs;
  },
  "word before scope": (doc) => {
    doc.words[0].startUs = String(BigInt(doc.scope.startUs) - 1n);
  },
  "word after scope": (doc) => {
    doc.words[0].endUs = String(BigInt(doc.scope.endUs) + 1n);
  },
  "silence crossing lower scope boundary": (doc) => {
    doc.intervals[0].startUs = String(BigInt(doc.scope.startUs) - 1n);
  },
  "silence crossing upper scope boundary": (doc) => {
    doc.intervals[0].endUs = String(BigInt(doc.scope.endUs) + 1n);
  },
};
for (const [name, mutate] of Object.entries(scopeMutations))
  test(`rejects ${name}`, () => {
    const data = goldFixture();
    const type = name.startsWith("silence") ? "silence_labels" : "word_alignment";
    const { doc, source } = entry(data, type);
    mutate(doc, source);
    doc.review.evidence.reviewedContentSha256 = contentSha256(doc);
    reindex(data);
    assert.equal(report(data).DATASET_STRUCTURALLY_VALID, false);
    assert.equal(
      report(data)[
        type === "silence_labels" ? "APPROVED_SILENCE_LABEL_COUNT" : "APPROVED_WORD_ALIGNMENT_COUNT"
      ],
      2,
    );
  });
test("three distinct scoped gold clips cover two English and one Arabic, without whole-source annotation", () => {
  const data = goldFixture();
  const gold = data.manifest.sources.filter((s) =>
    s.referenceArtifacts.some((a) => a.type === "word_alignment"),
  );
  assert.equal(gold.filter((s) => s.language === "en").length, 2);
  assert.equal(gold.filter((s) => s.language === "ar").length, 1);
  for (const s of gold) {
    const a = s.referenceArtifacts.find((a) => a.type === "word_alignment");
    const scope = data.documents.get(a.metadataPath).data.scope;
    assert.equal(BigInt(scope.endUs) - BigInt(scope.startUs), 60000000n);
    assert.ok(BigInt(scope.endUs) < BigInt(s.durationUs));
  }
  assert.equal(report(data).APPROVED_WORD_ALIGNMENT_COUNT, 3);
  assert.equal(report(data).APPROVED_SILENCE_LABEL_COUNT, 3);
});
test("word metric inputs use only approved scope, midpoint inclusion and clipped source bounds", () => {
  const { doc, source } = entry(goldFixture(), "word_alignment");
  const result = scopedMetricInputs(
    "word_alignment",
    doc,
    source,
    [
      { text: "outside", startUs: "0", endUs: "20000000" },
      { text: "lower", startUs: "29000000", endUs: "32000000" },
      { text: "inside", startUs: "50000000", endUs: "51000000" },
      { text: "upper", startUs: "88000000", endUs: "91000000" },
      { text: "outside", startUs: "92000000", endUs: "94000000" },
    ],
    null,
  );
  assert.deepEqual(
    result.predictions.map((p) => [p.text, p.startUs, p.endUs]),
    [
      ["lower", "30000000", "32000000"],
      ["inside", "50000000", "51000000"],
      ["upper", "88000000", "90000000"],
    ],
  );
  assert.equal(result.durationUs, "60000000");
  doc.review = { status: "awaiting_human_review" };
  assert.throws(() => scopedMetricInputs("word_alignment", doc, source, [], null), /approved/);
});
test("silence metric inputs intersect predictions with scope and use clip duration", () => {
  const { doc, source } = entry(goldFixture(), "silence_labels");
  const result = scopedMetricInputs(
    "silence_labels",
    doc,
    source,
    [
      { startUs: "0", endUs: "31000000" },
      { startUs: "88000000", endUs: "100000000" },
    ],
    null,
  );
  assert.deepEqual(result.predictions, [
    { startUs: "30000000", endUs: "31000000" },
    { startUs: "88000000", endUs: "90000000" },
  ]);
  assert.equal(result.durationUs, "60000000");
  assert.throws(
    () => scopedMetricInputs("silence_labels", doc, source, [{ startUs: "2.3", endUs: "5" }], null),
    /decimal/,
  );
  assert.throws(
    () => scopedMetricInputs("silence_labels", doc, source, [{ startUs: "5", endUs: "4" }], null),
    /ordered/,
  );
});
test("local viewing helper extracts the explicit scope via existing safe argument arrays", () => {
  const edit = annotationEdit({ startUs: "30000000", endUs: "90000000" });
  const args = renderArguments("/local/source.webm", "/local/window.mp4", edit, true);
  assert.ok(args.includes("file"));
  assert.match(args[args.indexOf("-filter_complex") + 1], /trim=start=30\.000000:end=90\.000000/);
  assert.equal(args[args.indexOf("-t") + 1], "60.000000");
});
function withSyntheticDurableEvidence(data) {
  data.manifest.storage.durableTarget = {
    endpoint: "https://synthetic-test.example/",
    approvedBy: "synthetic-test-owner",
    approvedAt: "2026-10-09T00:00:00Z",
    notes: "Synthetic test target approval, never a real storage destination",
  };
  data.storageEvidence = {
    schemaVersion: "1.0",
    datasetVersion: data.manifest.datasetVersion,
    datasetSha256: datasetSha256(data.manifest, data.registry),
    endpoint: data.manifest.storage.durableTarget.endpoint,
    bucket: data.manifest.storage.bucket,
    versioning: "Enabled",
    syncCompletedAt: "2026-10-09T00:00:00Z",
    deepVerifiedAt: "2026-10-09T00:01:00Z",
    objects: data.manifest.sources
      .flatMap((s) => [s, ...s.referenceArtifacts])
      .map((a) => ({
        id: a.id,
        objectKey: a.objectKey,
        sha256: a.sha256,
        sizeBytes: a.sizeBytes,
        versionId: "synthetic-test-version",
      })),
  };
  return data;
}
test("a later unreleased version can receive genuine human gold; release also needs durable exact verification", () => {
  const data = goldFixture();
  assert.equal(data.manifest.datasetVersion, "evaluation-dataset-v2");
  assert.doesNotThrow(() => assertDatasetMutable(data.manifest));
  assert.equal(report(data).HUMAN_GOLD_COMPLETE, true);
  assert.equal(report(data).US110_GOLD_COMPLETE, false);
  withSyntheticDurableEvidence(data);
  assert.equal(report(data).US110_GOLD_COMPLETE, true);
});
test("published snapshot is frozen; semantic mutation requires a later version", () => {
  const data = withSyntheticDurableEvidence(goldFixture());
  data.manifest.release = {
    status: "published",
    frozenDatasetSha256: datasetSha256(data.manifest, data.registry),
  };
  assert.equal(report(data).US110_GOLD_COMPLETE, true);
  assert.throws(() => assertDatasetMutable(data.manifest), /fork a later/);
  data.registry.metrics[0].definition += " Changed semantic meaning.";
  assert.equal(report(data).DATASET_STRUCTURALLY_VALID, false);
  assert.equal(report(data).US110_GOLD_COMPLETE, false);
});
for (const mutation of ["missing", "local", "hash", "version", "object", "duplicate", "timestamp"])
  test(`durable release gate rejects ${mutation} verification evidence`, () => {
    const data = withSyntheticDurableEvidence(goldFixture());
    if (mutation === "missing") data.storageEvidence = null;
    if (mutation === "local") data.manifest.storage.durableTarget.endpoint = "https://localhost/";
    if (mutation === "hash") data.storageEvidence.datasetSha256 = "0".repeat(64);
    if (mutation === "version") data.storageEvidence.objects[0].versionId = "null";
    if (mutation === "object") data.storageEvidence.objects[0].sha256 = "0".repeat(64);
    if (mutation === "duplicate") data.storageEvidence.objects[1] = data.storageEvidence.objects[0];
    if (mutation === "timestamp") data.storageEvidence.syncCompletedAt = "2026-10-10T00:00:00Z";
    assert.equal(report(data).HUMAN_GOLD_COMPLETE, true);
    assert.equal(report(data).GOLD_STORAGE_DURABLE, false);
    assert.equal(report(data).US110_GOLD_COMPLETE, false);
  });

test("forking a published snapshot archives frozen gold/evidence and makes the later version mutable", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "us110-published-fork-test-"));
  mkdirSync(resolve(root, "docs"));
  cpSync(resolve(repositoryRoot, "docs/evaluation"), resolve(root, "docs/evaluation"), {
    recursive: true,
  });
  const data = withSyntheticDurableEvidence(goldFixture());
  data.manifest.release = {
    status: "published",
    frozenDatasetSha256: datasetSha256(data.manifest, data.registry),
  };
  for (const [path, document] of data.documents)
    writeFileSync(resolve(root, path), JSON.stringify(document.data));
  writeFileSync(resolve(root, "docs/evaluation/manifest.json"), JSON.stringify(data.manifest));
  writeFileSync(resolve(root, "docs/evaluation/metrics.json"), JSON.stringify(data.registry));
  writeFileSync(
    resolve(root, "docs/evaluation/storage-verification.json"),
    JSON.stringify(data.storageEvidence),
  );
  try {
    await forkVersion("evaluation-dataset-v3", root);
    const current = loadDataset(root);
    assert.doesNotThrow(() => assertDatasetMutable(current.manifest));
    assert.equal(current.storageEvidence, null);
    assert.equal(report(current).US110_GOLD_COMPLETE, false);
    const archive = loadDataset(resolve(root, "docs/evaluation/releases/evaluation-dataset-v2"));
    assert.equal(report(archive).US110_GOLD_COMPLETE, true);
    assert.throws(() => assertDatasetMutable(archive.manifest), /fork a later/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unreleased approved artifact requires explicit review invalidation, not a version fork", () => {
  const data = goldFixture();
  const { doc } = entry(data, "word_alignment");
  assert.throws(() => assertArtifactMutable(data.manifest, doc), /explicitly reset review/);
  doc.review = { status: "awaiting_human_review" };
  doc.words[0].text = "Synthetic changed word";
  reindex(data);
  assert.doesNotThrow(() => assertArtifactMutable(data.manifest, doc));
  assert.equal(report(data).APPROVED_WORD_ALIGNMENT_COUNT, 2);
  approve(doc);
  reindex(data);
  assert.equal(report(data).APPROVED_WORD_ALIGNMENT_COUNT, 3);
  assert.equal(data.manifest.datasetVersion, "evaluation-dataset-v2");
  data.manifest.release = {
    status: "published",
    frozenDatasetSha256: datasetSha256(data.manifest, data.registry),
  };
  doc.review = { status: "awaiting_human_review" };
  assert.throws(() => assertArtifactMutable(data.manifest, doc), /fork a later/);
});

test("Owner-generated gold preserves real machine provenance and separate counters", () => {
  const data = fixture(true),
    r = report(data);
  assert.equal(r.DATASET_STRUCTURALLY_VALID, true, r.errors.join("; "));
  assert.equal(r.OWNER_APPROVED_GOLD, true);
  assert.equal(r.HUMAN_CREATED_GOLD, false);
  assert.equal(r.US110_RELEASE_COMPLETE, false);
  const arabic = data.manifest.sources.find((s) => s.id === "commons-82236797");
  const words = data.documents.get(
    arabic.referenceArtifacts.find((a) => a.type === "word_alignment").metadataPath,
  ).data.words;
  assert.ok(words.some((w) => /[\u0600-\u06ff]/.test(w.text)));
  assert.ok(words.every((w) => !w.text.includes("\ufffd")));
  for (const type of ["word_alignment", "silence_labels"]) {
    const { doc } = entry(data, type);
    assert.equal(doc.createdBy, "machine_generated");
    assert.equal(doc.review.evidence.approvalBasis, "owner_accepted_generated");
    assert.equal(doc.review.evidence.reviewerId, "project-owner");
    assert.equal(doc.review.evidence.reviewedContentSha256, contentSha256(doc));
  }
});
const generatedMutations = {
  "missing Owner waiver": (d) => {
    delete d.manifest.ownerDecision;
  },
  "invalid Owner decision date": (d) => {
    d.manifest.ownerDecision.decidedAt = "2026-99-99T00:00:00Z";
  },
  "wrong accepted source": (d) => {
    d.manifest.ownerDecision.acceptedSourceIds[0] = "commons-148215183";
  },
  "machine provenance falsely relabelled human": (d) => {
    entry(d, "word_alignment").doc.createdBy = "human";
  },
  "missing generation provenance": (d) => {
    delete entry(d, "word_alignment").doc.generation;
  },
  "wrong generating model": (d) => {
    entry(d, "word_alignment").doc.generation.modelId = "unverified";
  },
  "wrong generating parameters": (d) => {
    entry(d, "word_alignment").doc.generation.parameters.beamSize = 1;
  },
  "wrong generating tool version": (d) => {
    entry(d, "word_alignment").doc.generation.toolVersions["faster-whisper"] = "unknown";
  },
  "wrong approval basis": (d) => {
    entry(d, "word_alignment").doc.review.evidence.approvalBasis = "human_created";
  },
  "wrong waiver link": (d) => {
    entry(d, "word_alignment").doc.review.evidence.deviationId = "unapproved";
  },
  "wrong generated reviewer": (d) => {
    entry(d, "word_alignment").doc.review.evidence.reviewerId = "not-project-owner";
  },
  "different generated scope": (d) => {
    entry(d, "word_alignment").doc.scope.endUs = "90001000";
  },
  "empty generated word gold": (d) => {
    entry(d, "word_alignment").doc.words = [];
  },
  "empty generated silence gold": (d) => {
    entry(d, "silence_labels").doc.intervals = [];
  },
};
for (const [name, mutate] of Object.entries(generatedMutations))
  test(`rejects generated baseline with ${name}`, () => {
    const data = fixture(true);
    mutate(data);
    // Re-sign only synthetic copied fingerprints so semantic validation must catch the defect.
    for (const value of data.documents.values())
      if (value.data.createdBy === "machine_generated" && value.data.review.evidence)
        value.data.review.evidence.reviewedContentSha256 = contentSha256(value.data);
    reindex(data);
    const r = report(data);
    assert.equal(r.DATASET_STRUCTURALLY_VALID, false);
    assert.equal(r.US110_GOLD_COMPLETE, false);
  });
test("unapproved generated output does not count despite the waiver", () => {
  const data = fixture(true);
  entry(data, "word_alignment").doc.review = { status: "awaiting_human_review" };
  reindex(data);
  const r = report(data);
  assert.equal(r.DATASET_STRUCTURALLY_VALID, true, r.errors.join("; "));
  assert.equal(r.OWNER_APPROVED_WORD_ALIGNMENT_COUNT, 2);
  assert.equal(r.US110_GOLD_COMPLETE, false);
});
test("generated scoped metrics require the exact Owner decision and report provenance", () => {
  const data = fixture(true);
  const { doc, source } = entry(data, "word_alignment");
  assert.throws(() => scopedMetricInputs("word_alignment", doc, source, []), /explicit Owner/);
  const result = scopedMetricInputs("word_alignment", doc, source, [], data.manifest.ownerDecision);
  assert.equal(result.provenance, "owner_approved_generated");
  assert.equal(result.durationUs, "60000000");
  const different = clone(data.manifest.ownerDecision);
  different.scope.endUs = "91000000";
  assert.throws(() => scopedMetricInputs("word_alignment", doc, source, [], different), /Owner/);
});
test("word conversion keeps Arabic Unicode, source offsets and real positive model timing", () => {
  const scope = { startUs: "30000000", endUs: "90000000" };
  assert.equal(wordMicroseconds(0.0000005), 1n);
  assert.deepEqual(
    normalizedModelWords(
      [
        { text: " مرحباً،", start: 1.25, end: 1.5 },
        { text: "zero", start: 2, end: 2 },
      ],
      scope,
    ),
    [{ text: "مرحباً،", startUs: "31250000", endUs: "31500000" }],
  );
  assert.throws(() => wordMicroseconds(NaN), /Invalid model/);
  assert.throws(
    () =>
      normalizedModelWords(
        [
          { text: "a", start: 1, end: 2 },
          { text: "b", start: 1.5, end: 3 },
        ],
        scope,
      ),
    /overlap/,
  );
});
test("silence conversion complements actual VAD samples inside the full accepted scope", () => {
  const scope = { startUs: "30000000", endUs: "90000000" };
  assert.deepEqual(silenceComplement([{ start: 16000, end: 32000 }], scope), [
    { startUs: "30000000", endUs: "31000000" },
    { startUs: "32000000", endUs: "90000000" },
  ]);
  assert.deepEqual(silenceComplement([{ start: 0, end: 960000 }], scope), []);
  assert.throws(() => silenceComplement([{ start: 1, end: 960001 }], scope), /Invalid VAD/);
});
test("optional Python generation conversions are tested without inference dependencies", () => {
  const result = spawnSync(
    "python3",
    ["-m", "unittest", "discover", "-s", "tools/evaluation", "-p", "test_generate.py"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("QA36-F3 wrong_reviewer_human_edit_spec rejects a recomputed metadata identity", () => {
  const data = fixture(true),
    { doc } = entry(data, "edit_spec");
  doc.review.evidence.reviewerId = "another-owner";
  doc.review.evidence.reviewedContentSha256 = contentSha256(doc);
  reindex(data);
  const r = report(data);
  assert.equal(r.DATASET_STRUCTURALLY_VALID, false);
  assert.equal(r.APPROVED_HUMAN_REFERENCE_COUNT, 5);
  assert.match(r.errors.join("; "), /reviewerId|project-owner/);
});
test("QA36-F3 approved human annotations also require the exact Owner reviewer", () => {
  const data = goldFixture(),
    { doc } = entry(data, "silence_labels");
  doc.review.evidence.reviewerId = "another-owner";
  reindex(data);
  assert.equal(report(data).DATASET_STRUCTURALLY_VALID, false);
});
const qa36Mutations = {
  generated_marked_human_keep_generation: (d) => {
    d.createdBy = "human";
  },
  generated_marked_human_drop_generation: (d) => {
    d.createdBy = "human";
    delete d.generation;
  },
  generated_marked_human_drop_basis: (d) => {
    d.createdBy = "human";
    delete d.generation;
    delete d.review.evidence.approvalBasis;
    delete d.review.evidence.deviationId;
  },
  generated_missing_approval_basis: (d) => {
    delete d.review.evidence.approvalBasis;
  },
  generated_missing_deviation_id: (d) => {
    delete d.review.evidence.deviationId;
  },
  generated_wrong_reviewer: (d) => {
    d.review.evidence.reviewerId = "another-owner";
  },
};
for (const [name, mutate] of Object.entries(qa36Mutations))
  for (const type of ["word_alignment", "silence_labels"])
    test(`QA36-F3 rejects ${name} for ${type}, even after unsigned fingerprints are recomputed`, () => {
      const data = fixture(true),
        { doc, source } = entry(data, type);
      mutate(doc);
      doc.review.evidence.reviewedContentSha256 = contentSha256(doc);
      reindex(data);
      const r = report(data);
      assert.equal(r.DATASET_STRUCTURALLY_VALID, false);
      assert.equal(r.HUMAN_CREATED_GOLD, false);
      assert.equal(r.OWNER_ACCEPTED_GOLD_COMPLETE, false);
      assert.throws(() => scopedMetricInputs(type, doc, source, [], data.manifest.ownerDecision));
      assert.throws(() => scopedMetricInputs(type, doc, source, []), /context/);
    });
test("QA36-F3 rejects a mismatched manifest-bound generation identity", () => {
  const data = fixture(true);
  data.manifest.ownerDecision.acceptedArtifacts[0].generationSha256 = "0".repeat(64);
  assert.equal(report(data).DATASET_STRUCTURALLY_VALID, false);
});
test("QA36-F3 rejects a missing or duplicate accepted artifact binding", () => {
  for (const mutation of ["missing", "duplicate"]) {
    const data = fixture(true);
    if (mutation === "missing") data.manifest.ownerDecision.acceptedArtifacts.pop();
    else
      data.manifest.ownerDecision.acceptedArtifacts[0] = clone(
        data.manifest.ownerDecision.acceptedArtifacts[1],
      );
    assert.equal(report(data).DATASET_STRUCTURALLY_VALID, false);
  }
});
test("QA36-F3 rejects applying the v1 decision to another dataset identity", () => {
  const data = fixture(true);
  data.manifest.ownerDecision.datasetVersion = "evaluation-dataset-v2";
  assert.equal(report(data).DATASET_STRUCTURALLY_VALID, false);
});
test("a later dataset without this decision may contain genuine human-created replacements", () => {
  const data = goldFixture();
  data.manifest.datasetVersion = data.registry.datasetVersion = "evaluation-dataset-v2";
  data.manifest.storage.prefix = "evaluation/evaluation-dataset-v2/";
  for (const source of data.manifest.sources) {
    source.objectKey = objectKey(data.manifest.datasetVersion, "sources", source);
    for (const a of source.referenceArtifacts) {
      a.datasetVersion = data.manifest.datasetVersion;
      const doc = data.documents.get(a.metadataPath)?.data;
      if (doc) {
        doc.datasetVersion = data.manifest.datasetVersion;
        if (doc.review?.evidence) doc.review.evidence.reviewedContentSha256 = contentSha256(doc);
      } else a.objectKey = objectKey(data.manifest.datasetVersion, "references", a);
    }
    const edit = source.referenceArtifacts.find((a) => a.type === "edit_spec");
    if (edit)
      data.documents.get(
        source.referenceArtifacts.find((a) => a.type === "render_receipt").metadataPath,
      ).data.editContentSha256 = contentSha256(data.documents.get(edit.metadataPath).data);
  }
  reindex(data);
  const r = report(data);
  assert.equal(r.DATASET_STRUCTURALLY_VALID, true, r.errors.join("; "));
  assert.equal(r.HUMAN_CREATED_GOLD, true);
});
test("producer evidence verifies exact bytes and conversions without inference", () => {
  const source = { id: "synthetic-source", sha256: "a".repeat(64), language: "ar" };
  const scope = { startUs: "30000000", endUs: "90000000" };
  const pcm = Buffer.from("synthetic test bytes; not a real dataset asset");
  const raw = {
    words: [{ text: " مرحباً،", start: 1, end: 2 }],
    speechSamples: [{ start: 16000, end: 32000 }],
    omittedWords: [],
  };
  const rawBytes = Buffer.from(JSON.stringify(raw));
  const generation = { inputAudioSha256: sha256(pcm), rawOutputSha256: sha256(rawBytes) };
  const words = {
    sourceId: source.id,
    sourceSha256: source.sha256,
    scope,
    generation,
    words: normalizedModelWords(raw.words, scope),
  };
  const silence = {
    sourceId: source.id,
    sourceSha256: source.sha256,
    scope,
    generation,
    intervals: silenceComplement(raw.speechSamples, scope),
  };
  const generated = {
    sourceId: source.id,
    sourceSha256: source.sha256,
    language: source.language,
    scope,
    wordGeneration: generation,
    silenceGeneration: generation,
    words: words.words,
    intervals: silence.intervals,
  };
  const generatedBytes = Buffer.from(JSON.stringify(generated));
  assert.doesNotThrow(() =>
    verifyProducerBytes(source, words, silence, { pcm, rawBytes, generatedBytes }),
  );
  assert.throws(() =>
    verifyProducerBytes(source, words, silence, {
      pcm: Buffer.from("substitute"),
      rawBytes,
      generatedBytes,
    }),
  );
  assert.throws(() =>
    verifyProducerBytes(source, words, silence, {
      pcm,
      rawBytes: Buffer.from(JSON.stringify({ ...raw, omittedWords: ["changed"] })),
      generatedBytes,
    }),
  );
  assert.throws(() =>
    verifyProducerBytes(source, words, silence, {
      pcm,
      rawBytes,
      generatedBytes: Buffer.from(JSON.stringify({ ...generated, language: "en" })),
    }),
  );
});

test("actual producer archive metadata covers all three original inputs/results and stays outside git", () => {
  const data = fixture(true),
    evidence = data.manifest.sources.flatMap((s) => s.producerEvidence || []);
  assert.equal(evidence.length, 9);
  assert.deepEqual([...new Set(evidence.map((e) => e.type))].sort(), [
    "generation_output",
    "inference_raw",
    "scoped_pcm",
  ]);
  assert.ok(
    evidence.every(
      (e) =>
        e.datasetVersion === data.manifest.datasetVersion &&
        e.annotationIds.length === 2 &&
        e.objectKey.startsWith(`evaluation/${data.manifest.datasetVersion}/producer-evidence/`),
    ),
  );
  assert.equal(report(data).DATASET_STRUCTURALLY_VALID, true);
});
for (const mutation of ["hash", "source", "scope", "annotation", "key", "type"])
  test(`producer archive rejects an invalid ${mutation} binding`, () => {
    const data = fixture(true),
      evidence = data.manifest.sources.find((s) => s.producerEvidence).producerEvidence[0];
    if (mutation === "hash") {
      evidence.sha256 = "0".repeat(64);
      evidence.objectKey = objectKey(data.manifest.datasetVersion, "producer-evidence", evidence);
    }
    if (mutation === "source") evidence.sourceSha256 = "0".repeat(64);
    if (mutation === "scope") evidence.scope.endUs = "91000000";
    if (mutation === "annotation") evidence.annotationIds[0] = "nonexistent-annotation";
    if (mutation === "key") evidence.objectKey = "another-prefix/raw.wav";
    if (mutation === "type") evidence.type = "unknown";
    assert.equal(report(data).DATASET_STRUCTURALLY_VALID, false);
  });

// QA attacks use copies of the real approved dataset and update every mutable checksum.
// Rejection must come from the code-pinned policy, never a stale metadata checksum.
test("QA36R-F1 whole_manifest_human_gold_escalation rejects through the real CLI", () => {
  const data = fixture(true);
  delete data.manifest.ownerDecision;
  for (const source of data.manifest.sources) {
    delete source.producerEvidence;
    for (const artifact of source.referenceArtifacts) {
      const doc = data.documents.get(artifact.metadataPath)?.data;
      if (doc?.createdBy !== "machine_generated") continue;
      doc.createdBy = "human";
      delete doc.generation;
      delete doc.review.evidence.approvalBasis;
      delete doc.review.evidence.deviationId;
      doc.review.evidence.reviewedContentSha256 = contentSha256(doc);
    }
  }
  reindex(data);
  const r = report(data);
  assert.equal(r.DATASET_STRUCTURALLY_VALID, false);
  assert.equal(r.HUMAN_CREATED_GOLD, false);
  assert.equal(r.HUMAN_GOLD_COMPLETE, false);
  assert.match(r.errors.join("; "), /Authoritative v1 provenance policy/);
  const root = mkdtempSync(resolve(tmpdir(), "us110-escalation-"));
  try {
    mkdirSync(resolve(root, "docs"));
    mkdirSync(resolve(root, "tools"));
    cpSync(resolve(repositoryRoot, "docs/evaluation"), resolve(root, "docs/evaluation"), {
      recursive: true,
    });
    cpSync(resolve(repositoryRoot, "tools/evaluation"), resolve(root, "tools/evaluation"), {
      recursive: true,
    });
    symlinkSync(resolve(repositoryRoot, "packages"), resolve(root, "packages"), "dir");
    symlinkSync(resolve(repositoryRoot, "docs/roadmap"), resolve(root, "docs/roadmap"), "dir");
    for (const [path, doc] of data.documents)
      writeFileSync(resolve(root, path), JSON.stringify(doc.data));
    writeFileSync(resolve(root, "docs/evaluation/manifest.json"), JSON.stringify(data.manifest));
    const result = spawnSync(
      process.execPath,
      [resolve(root, "tools/evaluation/validate.mjs"), "--require-human-gold"],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout.trim(), result.stderr);
    const cli = JSON.parse(result.stdout);
    assert.equal(cli.DATASET_STRUCTURALLY_VALID, false);
    assert.equal(cli.HUMAN_CREATED_GOLD, false);
    assert.equal(cli.HUMAN_GOLD_COMPLETE, false);
    assert.match(cli.errors.join("; "), /Authoritative v1 provenance policy/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const mutation of ["content", "generation", "scope", "artifact ID"])
  test(`QA36R-F2 code-pinned decision rejects consistently rebound ${mutation}`, () => {
    const data = fixture(true);
    const { doc, source, artifact } = entry(data, "word_alignment");
    const binding = data.manifest.ownerDecision.acceptedArtifacts.find(
      (a) => a.artifactId === doc.id,
    );
    if (mutation === "content") doc.words[0].text += " changed";
    if (mutation === "generation") doc.generation.toolVersions["faster-whisper"] = "changed";
    if (mutation === "scope") {
      data.manifest.ownerDecision.scope.startUs = "29000000";
      for (const s of data.manifest.sources) {
        for (const a of s.referenceArtifacts) {
          const d = data.documents.get(a.metadataPath)?.data;
          if (d?.createdBy === "machine_generated") d.scope.startUs = "29000000";
        }
        for (const e of s.producerEvidence || []) e.scope.startUs = "29000000";
      }
    }
    if (mutation === "artifact ID") {
      const oldId = doc.id;
      doc.id = artifact.id = binding.artifactId = `${oldId}-replacement`;
      for (const e of source.producerEvidence)
        e.annotationIds = e.annotationIds.map((id) => (id === oldId ? doc.id : id));
    }
    for (const accepted of data.manifest.ownerDecision.acceptedArtifacts) {
      const s = data.manifest.sources.find((item) => item.id === accepted.sourceId);
      const a = s.referenceArtifacts.find((item) => item.id === accepted.artifactId);
      const d = data.documents.get(a.metadataPath).data;
      accepted.contentSha256 = contentSha256(d);
      accepted.generationSha256 = contentSha256(d.generation);
      d.review.evidence.reviewedContentSha256 = contentSha256(d);
    }
    reindex(data);
    const r = report(data);
    assert.equal(r.DATASET_STRUCTURALLY_VALID, false);
    assert.match(r.errors.join("; "), /exact pinned Owner decision/);
    assert.equal(r.OWNER_ACCEPTED_GOLD_COMPLETE, false);
  });

for (const mutation of ["missing source evidence", "missing evidence object", "rebound evidence"])
  test(`QA36R-F1 authoritative v1 policy rejects ${mutation}`, () => {
    const data = fixture(true);
    const source = data.manifest.sources.find((s) => s.producerEvidence);
    if (mutation === "missing source evidence") delete source.producerEvidence;
    if (mutation === "missing evidence object") source.producerEvidence.pop();
    if (mutation === "rebound evidence") {
      const item = source.producerEvidence.find((e) => e.type === "generation_output");
      item.sha256 = "0".repeat(64);
      item.objectKey = objectKey(data.manifest.datasetVersion, "producer-evidence", item);
    }
    const r = report(data);
    assert.equal(r.DATASET_STRUCTURALLY_VALID, false);
    assert.match(r.errors.join("; "), /Authoritative v1 provenance policy/);
  });

for (const mode of ["new", "existing", "symlink", "directory symlink"])
  test(`QA36R-F4 evidence destination ${mode}`, () => {
    const root = mkdtempSync(resolve(tmpdir(), "us110-evidence-destination-"));
    const real = resolve(root, "real");
    mkdirSync(real);
    const directory = mode === "directory symlink" ? resolve(root, "linked") : real;
    const target = resolve(root, "protected");
    const bytes = Buffer.from("verified producer bytes");
    const item = { id: "source-inference-raw", extension: "json", sha256: sha256(bytes) };
    const to = resolve(directory, `${item.id}.${item.extension}`);
    writeFileSync(target, "protected existing bytes");
    try {
      if (mode === "existing") writeFileSync(to, "existing evidence");
      if (mode === "symlink") symlinkSync(target, to);
      if (mode === "directory symlink") symlinkSync(real, directory, "dir");
      if (mode === "new") {
        stageEvidence([{ item, bytes, to }], directory);
        assert.deepEqual(readFileSync(to), bytes);
        assert.throws(() => stageEvidence([{ item, bytes, to }], directory), /already exists/);
      } else {
        assert.throws(
          () => stageEvidence([{ item, bytes, to }], directory),
          /already exists|symlinks/,
        );
        if (mode === "existing") assert.equal(readFileSync(to, "utf8"), "existing evidence");
      }
      assert.equal(readFileSync(target, "utf8"), "protected existing bytes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

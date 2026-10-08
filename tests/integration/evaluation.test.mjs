import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, cpSync } from "node:fs";
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
} from "../../tools/evaluation/validate.mjs";
import { storageConfig, syncItem, verifyRemote } from "../../tools/evaluation/storage.mjs";
import { renderArguments, seconds } from "../../tools/evaluation/references.mjs";
import { forkVersion } from "../../tools/evaluation/version.mjs";
import { metricsMarkdown } from "../../tools/evaluation/docs.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
function fixture() {
  const real = loadDataset();
  return {
    manifest: clone(real.manifest),
    registry: clone(real.registry),
    documents: new Map([...real.documents].map(([key, value]) => [key, clone(value)])),
  };
}
function report(data) {
  return validateDataset(data.manifest, data.registry, data.documents);
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
  doc.review = {
    status: "approved",
    evidence: {
      reviewerId: "synthetic-test-owner",
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
        doc.intervals = [{ startUs: "0", endUs: "1000000" }];
        approve(doc);
      }
      if (artifact.type === "word_alignment") {
        doc.words = [
          {
            text: source.language === "ar" ? "مرحباً،" : "Hello,",
            startUs: "1000000",
            endUs: "2000000",
          },
        ];
        approve(doc);
      }
    }
  }
  reindex(data);
  return data;
}
test("actual manifest is structurally valid but honestly incomplete gold", () => {
  const r = report(fixture());
  assert.equal(r.DATASET_STRUCTURALLY_VALID, true, r.errors.join(";"));
  assert.equal(r.US110_GOLD_COMPLETE, false);
  assert.equal(r.LICENSED_SOURCE_COUNT, 12);
  assert.equal(r.CATEGORY_COUNT, 6);
  assert.equal(r.APPROVED_HUMAN_REFERENCE_COUNT, 0);
  assert.equal(r.APPROVED_SILENCE_LABEL_COUNT, 0);
  assert.equal(r.APPROVED_WORD_ALIGNMENT_COUNT, 0);
});
test("synthetic genuine-human-shaped evidence satisfies unchanged 6/3/3 quota", () => {
  const r = report(goldFixture());
  assert.equal(r.DATASET_STRUCTURALLY_VALID, true, r.errors.join(";"));
  assert.equal(r.US110_GOLD_COMPLETE, true);
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
    entry(d, "edit_spec").artifact.datasetVersion = "evaluation-dataset-v2";
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
    d.registry.datasetVersion = "evaluation-dataset-v2";
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
  const data = fixture();
  assert.equal(
    await metricsMarkdown(data.registry),
    readFileSync(resolve(repositoryRoot, "docs/evaluation/METRICS.md"), "utf8"),
  );
});
test("strict gold CLI exits nonzero while structural CLI passes", () => {
  for (const [args, expected] of [
    [[], 0],
    [["--require-gold"], 1],
  ]) {
    const r = spawnSync(process.execPath, ["tools/evaluation/validate.mjs", ...args], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.equal(r.status, expected, r.stderr);
    assert.match(r.stdout, /"US110_GOLD_COMPLETE": false/);
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

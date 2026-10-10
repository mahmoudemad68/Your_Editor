import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import process from "node:process";
import {
  MediaAnalysisSchema,
  AnalysisTimeSchema,
  SpeechAnalysisSchema,
} from "../../packages/schemas/dist/index.js";
import {
  generate,
  run,
  sourceFiles,
  targets,
} from "../../tools/schema/generate-media-analysis.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = resolve(root, "packages/schemas/fixtures/media-analysis");
const fixture = (name) => JSON.parse(readFileSync(resolve(fixtureRoot, `${name}.json`), "utf8"));
const names = ["minimal", "full", "partial-failure", "us202", "large-time"];
const require = createRequire(resolve(root, "packages/job-queue/package.json"));
const Ajv = require("ajv/dist/2020.js");
const ajv = new Ajv({ strict: true, allErrors: true });
ajv.addKeyword({ keyword: "x-editagent-checks", valid: true }); // Standard annotation; generated boundaries enforce relational checks.
for (const path of sourceFiles)
  ajv.addSchema(JSON.parse(readFileSync(resolve(root, path), "utf8")));
const jsonSchema = ajv.getSchema(
  "https://editagent.local/schemas/media-analysis/1.0.0.schema.json",
);
function python(documents, extra = {}) {
  return JSON.parse(
    execFileSync(
      "uv",
      [
        "run",
        "--frozen",
        "--project",
        resolve(root, "workers/ai-worker"),
        "python",
        resolve(root, "workers/ai-worker/tests/media_analysis_bridge.py"),
      ],
      {
        input: JSON.stringify({ documents, ...extra }),
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 32_000_000,
      },
    ),
  );
}
function digest(outputs) {
  return createHash("sha256")
    .update([...outputs].map(([p, s]) => `${p}\n${s}`).join("\n"))
    .digest("hex");
}

test("US-208 canonical fixtures validate under offline JSON Schema, Zod and Pydantic", () => {
  const docs = names.map(fixture);
  const produced = python(docs);
  for (const [i, doc] of docs.entries()) {
    assert.equal(jsonSchema(doc), true, JSON.stringify(jsonSchema.errors));
    assert.deepEqual(MediaAnalysisSchema.parse(doc), doc);
    assert.equal(produced[i].valid, true, names[i]);
    assert.deepEqual(produced[i].document, doc); // Includes absent optional fields and Unicode.
    assert.deepEqual(MediaAnalysisSchema.parse(produced[i].document), doc); // Python -> TS.
  }
  const fromTs = docs.map((d) => JSON.parse(JSON.stringify(MediaAnalysisSchema.parse(d))));
  assert.deepEqual(
    python(fromTs).map((p) => p.document),
    docs,
  ); // TS -> Python.
});

test("US-208 embeds existing US-202 output without losing configuration, scope or confidence", () => {
  const doc = fixture("us202");
  const outputs = python([doc], {
    checkSpeech: true,
    speechFixture: resolve(fixtureRoot, "us202.json"),
  });
  const speech = doc.sections.audio.data.speech;
  assert.deepEqual(outputs[1].us202, speech);
  assert.deepEqual(SpeechAnalysisSchema.parse(outputs[1].us202), speech);
  assert.deepEqual(python([MediaAnalysisSchema.parse(outputs[0].document)])[0].document, doc);
});

test("US-208 drift fails on a meaningful source mutation, regeneration fixes it, generation is deterministic", async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), "editagent-schema-drift-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of [...sourceFiles, ...targets]) {
    mkdirSync(dirname(resolve(directory, path)), { recursive: true });
    copyFileSync(resolve(root, path), resolve(directory, path));
  }
  const first = await generate();
  const second = await generate();
  assert.equal(digest(first), digest(second));
  t.diagnostic(
    `GENERATION_RUN_1_SHA256=${digest(first)} GENERATION_RUN_2_SHA256=${digest(second)}`,
  );
  await run(directory, true);
  const path = resolve(directory, "packages/schemas/src/analysis-transcript.schema.json");
  const schema = JSON.parse(readFileSync(path, "utf8"));
  schema.properties.language.maxLength = 34;
  writeFileSync(path, JSON.stringify(schema));
  await assert.rejects(run(directory, true), /Stale MediaAnalysis binding/);
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [resolve(root, "tools/schema/generate-media-analysis.mjs"), "--root", directory, "--check"],
        { encoding: "utf8", stdio: "pipe" },
      ),
    (error) => error.status === 1 && /Stale MediaAnalysis binding/.test(error.stderr),
  );
  await run(directory, false);
  await run(directory, true);
  schema.properties.language.default = "en"; // Unsupported features cannot disappear silently.
  writeFileSync(path, JSON.stringify(schema));
  await assert.rejects(generate(directory), /Unsupported schema keyword: default/);
});

test("US-208 invalid differential matrix rejects identically in both languages", (t) => {
  const cases = [];
  function mutate(name, change, base = "full") {
    const doc = fixture(base);
    change(doc);
    cases.push({ name, doc });
  }
  mutate("unknown root key", (d) => (d.untrusted = true));
  mutate("prototype pollution", (d) =>
    Object.defineProperty(d, "__proto__", { value: { polluted: true }, enumerable: true }),
  );
  mutate("nested constructor", (d) => (d.provenance.constructor = "bad"));
  mutate("wrong source primitive", (d) => (d.source.sha256 = 1));
  mutate(
    "uppercase UUID",
    (d) => (d.mediaAssetId = d.mediaAssetId.toUpperCase().replace("01900000", "019A0000")),
  );
  mutate("UUIDv4", (d) => (d.mediaAssetId = d.mediaAssetId.replace("7000", "4000")));
  mutate("bad version", (d) => (d.schemaVersion = "1.0.1"));
  mutate("number version", (d) => (d.schemaVersion = 1));
  mutate("negative time", (d) => (d.sections.transcript.data.segments[0].startUs = "-1"));
  mutate("fractional time", (d) => (d.sections.transcript.data.segments[0].startUs = "1.5"));
  mutate("numeric time", (d) => (d.source.durationUs = 120000000));
  mutate("leading zero", (d) => (d.source.durationUs = "0120000000"));
  mutate("newline time", (d) => (d.source.durationUs += "\n"));
  mutate("NaN-like string", (d) => (d.sections.transcript.data.languageConfidence = "NaN"));
  mutate(
    "confidence overflow",
    (d) => (d.sections.objects.data.tracks[0].observations[0].confidence = 1.01),
  );
  mutate(
    "boolean confidence",
    (d) => (d.sections.audio.data.speech.speechRegions[0].confidence = true),
  );
  mutate("missing completed data", (d) => delete d.sections.audio.data);
  mutate("failed with data", (d) => (d.sections.audio.status = "failed"));
  mutate("not available with data", (d) => (d.sections.audio.status = "not_available"));
  mutate("unknown lifecycle", (d) => (d.sections.audio.status = "pending"));
  mutate("null optional", (d) => (d.sections.transcript.data.languageConfidence = null));
  mutate(
    "extra nested",
    (d) => (d.sections.audio.data.speech.provenance.secret = "not-a-secret-fixture"),
  );
  mutate("reverse range", (d) => (d.sections.transcript.data.segments[0].endUs = "1"));
  mutate("out-of-source range", (d) => (d.sections.scenes.data.scenes[0].endUs = "120000001"));
  mutate("duplicate scene ID", (d) =>
    d.sections.scenes.data.scenes.push({
      ...d.sections.scenes.data.scenes[0],
      startUs: "1000000",
      endUs: "2000000",
    }),
  );
  mutate(
    "speech scope reversal",
    (d) => (d.sections.audio.data.speech.source.scopeStartUs = "90000000"),
  );
  mutate(
    "speech duration exceeds cap",
    (d) => (d.sections.audio.data.speech.source.sourceDurationUs = "1800000001"),
  );
  mutate(
    "speech newline time",
    (d) => (d.sections.audio.data.speech.speechRegions[0].endUs += "\n"),
  );
  mutate("speech bool schemaVersion", (d) => (d.sections.audio.data.speech.schemaVersion = true));
  mutate("speech string schemaVersion", (d) => (d.sections.audio.data.speech.schemaVersion = "1"));
  mutate(
    "speech runtimeVersion max",
    (d) => (d.sections.audio.data.speech.provenance.runtimeVersion = "a".repeat(33)),
  );
  mutate(
    "speech runtimeVersion newline",
    (d) => (d.sections.audio.data.speech.provenance.runtimeVersion += "\n"),
  );
  mutate(
    "hysteresis reversal",
    (d) => (d.sections.audio.data.speech.provenance.configuration.negativeThreshold = 0.6),
  );
  mutate(
    "padding exceeds safety",
    (d) => (d.sections.audio.data.speech.provenance.configuration.paddingUs = "1000001"),
  );
  mutate(
    "zero minimum speech",
    (d) => (d.sections.audio.data.speech.provenance.configuration.minSpeechUs = "0"),
  );
  mutate(
    "wrong source binding",
    (d) => (d.sections.audio.data.speech.source.sourceSha256 = "b".repeat(64)),
  );
  mutate(
    "wrong analyzer source binding",
    (d) => (d.sections.faces.provenance.sourceSha256 = "b".repeat(64)),
  );
  mutate(
    "box outside canvas",
    (d) => (d.sections.faces.data.tracks[0].observations[0].boundingBox.width = 1),
  );
  mutate(
    "zero box width",
    (d) => (d.sections.faces.data.tracks[0].observations[0].boundingBox.width = 0),
  );
  mutate(
    "out-of-track observation",
    (d) => (d.sections.faces.data.tracks[0].observations[0].atUs = "1000000"),
  );
  mutate("lone high surrogate", (d) => (d.sections.transcript.data.segments[0].text = "\ud800"));
  mutate("lone low surrogate", (d) => (d.sections.transcript.data.segments[0].text = "\udfff"));
  mutate(
    "oversized text",
    (d) => (d.sections.transcript.data.segments[0].words[0].text = "x".repeat(257)),
  );
  mutate("absurd metadata dimension", (d) => (d.sections.metadata.data.width = 2147483648));
  mutate("inconsistent orientation", (d) => (d.sections.metadata.data.rotation = 90));
  mutate("partial stored dimensions", (d) => delete d.sections.metadata.data.displayWidth);
  mutate("rotation without dimensions", (d) => {
    d.sections.metadata.data = { kind: "video", rotation: 0 };
  });
  mutate(
    "unsafe frame rate ratio",
    (d) => (d.sections.metadata.data.frameRate.numerator = "9223372036854775808"),
  );
  mutate("fractional dimension", (d) => (d.sections.metadata.data.width = 2.5));
  mutate(
    "bool retryable missing",
    (d) => delete d.sections.transcript.failure.retryable,
    "partial-failure",
  );
  mutate(
    "raw failure forbidden",
    (d) => (d.sections.transcript.failure.reason = "raw internal stderr /private/file"),
    "partial-failure",
  );
  mutate(
    "overlapping words",
    (d) => (d.sections.transcript.data.segments[0].words[1].startUs = "31499999"),
  );
  mutate(
    "word outside segment",
    (d) => (d.sections.transcript.data.segments[0].words[0].startUs = "30999999"),
  );
  mutate("unordered face observations", (d) =>
    d.sections.faces.data.tracks[0].observations.push({
      ...d.sections.faces.data.tracks[0].observations[0],
    }),
  );
  mutate("empty audio result", (d) => (d.sections.audio.data = {}));
  mutate("empty loudness result", (d) => (d.sections.audio.data.loudness = {}));
  mutate("oversized time representation", (d) => (d.source.durationUs = "1".repeat(21)));
  mutate("temporal result without source duration", (d) => delete d.source.durationUs);
  const outputs = python(cases.map((c) => c.doc));
  t.diagnostic(`INVALID_DIFFERENTIAL_CASES=${cases.length} SCHEMA_RUNTIME_MISMATCHES=0`);
  for (const [i, { name, doc }] of cases.entries()) {
    assert.equal(MediaAnalysisSchema.safeParse(doc).success, false, name);
    assert.equal(outputs[i].valid, false, `Python: ${name}`);
  }
  assert.equal(Object.prototype.polluted, undefined);
});

test("US-208 deterministic generated documents preserve large integer digits and empty sections", () => {
  let seed = 208;
  const docs = [];
  for (let i = 0; i < 24; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const doc = fixture("minimal");
    doc.source.durationUs = String(9007199254740993n + BigInt(seed));
    const pv = fixture("full").sections.scenes.provenance;
    doc.sections.scenes = { status: "completed", data: { scenes: [] }, provenance: pv };
    doc.sections.transcript = {
      status: "completed",
      data: { language: "en", segments: [] },
      provenance: pv,
    };
    docs.push(MediaAnalysisSchema.parse(doc));
  }
  assert.equal(AnalysisTimeSchema.parse("9007199254740993"), "9007199254740993");
  assert.deepEqual(
    python(docs).map((p) => p.document),
    docs,
  );
  assert.equal(JSON.stringify(fixture("large-time")).includes('"9007199254740993"'), true);
});

test("US-208 large representative document validates with bounded runtime cost", (t) => {
  const doc = fixture("minimal");
  doc.source.durationUs = "1800000000";
  const pv = fixture("full").sections.transcript.provenance;
  const words = Array.from({ length: 10000 }, (_, i) => ({
    text: i % 2 ? "hello" : "مرحبا 🌍",
    startUs: String(i * 100000),
    endUs: String((i + 1) * 100000),
    confidence: 0.9,
  }));
  doc.sections.transcript = {
    status: "completed",
    data: {
      language: "en",
      segments: [
        {
          id: "large-fixture",
          text: "Synthetic capacity fixture",
          startUs: "0",
          endUs: "1000000000",
          words,
        },
      ],
    },
    provenance: pv,
  };
  const before = process.hrtime.bigint();
  const valid = MediaAnalysisSchema.parse(doc);
  const ms = Number(process.hrtime.bigint() - before) / 1e6;
  const py = python([valid])[0];
  assert.equal(py.valid, true);
  t.diagnostic(
    `TS_VALIDATION_TIME_MS=${ms.toFixed(3)} PYTHON_VALIDATION_TIME_MS=${py.validationMs.toFixed(3)} WORD_COUNT=${words.length}`,
  );
});

test("US-208 metadata and Unicode preserve existing semantics and JSON numeric equivalence", () => {
  const rotated = fixture("full");
  rotated.sections.metadata.data.rotation = 90;
  rotated.sections.metadata.data.displayWidth = 1080;
  rotated.sections.metadata.data.displayHeight = 1920;
  const unicode = fixture("full");
  unicode.sections.transcript.data.segments[0].words[0].text = "🌍".repeat(256);
  const literal = fixture("us202");
  literal.sections.audio.data.speech.schemaVersion = 1.0;
  literal.sections.audio.data.speech.provenance.runtimeVersion = "x".repeat(32);
  for (const d of [rotated, unicode, literal]) {
    assert.equal(jsonSchema(d), true);
    assert.equal(MediaAnalysisSchema.safeParse(d).success, true);
  }
  assert.deepEqual(
    python([rotated, unicode, literal]).map((p) => p.valid),
    [true, true, true],
  );
  const canonical = MediaAnalysisSchema.parse(fixture("minimal"), { jitless: true });
  assert.deepEqual(python([canonical])[0].document, canonical);
});

test("US-208 Zod rejects non-JSON nonfinite numbers at the boundary", () => {
  for (const confidence of [NaN, Infinity, -Infinity]) {
    const document = fixture("full");
    document.sections.transcript.data.languageConfidence = confidence;
    assert.equal(MediaAnalysisSchema.safeParse(document).success, false);
  }
});

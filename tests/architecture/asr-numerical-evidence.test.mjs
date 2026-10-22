import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inferenceConfigurationSha256,
  qualifyNumericalRuntime,
  qualifyThreadEquivalent,
} from "../../tools/asr/qualification.mjs";

// Synthetic objects verify rejection controls, not real ASR or accuracy gold.
function worker(threads) {
  const parameters = { cpu_threads: threads, temperature: 0 };
  return {
    inferenceParameters: parameters,
    section: {
      data: { words: [{ text: " unit", startUs: "0", endUs: "20", confidence: 0.8 }] },
      provenance: {
        model: { sha256: "a".repeat(64) },
        configurationSha256: inferenceConfigurationSha256(parameters),
      },
    },
  };
}

test("cross-thread qualification compares full ordered data and verified provenance", () => {
  const single = worker(1),
    reference = worker(2);
  const before = JSON.stringify([single, reference]);
  qualifyThreadEquivalent(single, reference);
  assert.equal(JSON.stringify([single, reference]), before);
});

for (const defect of [
  "text",
  "start",
  "end",
  "confidence",
  "extra-word",
  "model",
  "configuration",
  "parameter",
]) {
  test(`cross-thread qualification rejects actual output differences: ${defect}`, () => {
    const single = worker(1),
      reference = worker(2);
    const word = single.section.data.words[0];
    if (defect === "text") word.text = " other";
    if (defect === "start") word.startUs = "1";
    if (defect === "end") word.endUs = "21";
    if (defect === "confidence") word.confidence = 0.81;
    if (defect === "extra-word") single.section.data.words.push({ ...word });
    if (defect === "model") single.section.provenance.model.sha256 = "b".repeat(64);
    if (defect === "configuration") single.section.provenance.configurationSha256 = "b".repeat(64);
    if (defect === "parameter") {
      single.inferenceParameters.temperature = 1;
      single.section.provenance.configurationSha256 = inferenceConfigurationSha256(
        single.inferenceParameters,
      );
    }
    assert.throws(() => qualifyThreadEquivalent(single, reference));
  });
}

test("configuration digest matches Python's nested sort_keys serialization", () => {
  const parameters = {
    cpu_threads: 2,
    nativeCpuEnvironment: { Z: "last", A: "first" },
    wordAlignmentPaddingUs: [400000, 1000000],
    temperature: 0,
    speech_threshold: 0.5,
  };
  // Independently calculated with the worker's Python JSON serialization.
  assert.equal(
    inferenceConfigurationSha256(parameters),
    "076e59a05476525e56a66a83693249b745736fa6e09be5bd2e40bee58f6989b0",
  );
  assert.notEqual(
    inferenceConfigurationSha256(parameters),
    inferenceConfigurationSha256({ ...parameters, cpu_threads: 1 }),
  );
});

function evidence() {
  return {
    schemaVersion: 2,
    probe: "integer-ramp-pcm16-16000-v1",
    python: "3.11.16",
    libc: { name: "glibc", version: "2.39" },
    machine: "x86_64",
    cpu: { vendor: "GenuineIntel", family: 6, model: 85, stepping: 7, uniform: true },
    packages: {
      numpy: "2.4.6",
      ctranslate2: "4.8.2",
      "faster-whisper": "1.2.1",
      onnxruntime: "1.31.0",
      av: "18.1.0",
    },
    ctranslate2ExtensionSha256: "a".repeat(64),
    vadGraphSha256: "4cbf549b8326f60f80f2536d9eefeb450a9abe83365a098031c89719f1be17d2",
    numpyKernels: {
      cos_float64: "X86_V3",
      absolute_complex64: "X86_V3",
      log_float64: "X86_V3",
    },
    synthetic: Object.fromEntries(
      [
        "pcmFloat32Sha256",
        "melFiltersFloat32Sha256",
        "hannFloat32Sha256",
        "stftComplex64Sha256",
        "logMelFloat32Sha256",
      ].map((key) => [key, "b".repeat(64)]),
    ),
  };
}

test("numerical evidence publishes only its explicit non-speech allowlist", () => {
  const input = evidence();
  input.privateOperand = "synthetic-private-sentinel";
  input.libc.path = "synthetic-private-sentinel";
  input.cpu.serial = "synthetic-private-sentinel";
  input.synthetic.words = "synthetic-private-sentinel";
  const result = qualifyNumericalRuntime(input);
  assert.deepEqual(result, evidence());
  assert.ok(!JSON.stringify(result).includes("synthetic-private-sentinel"));
  assert.equal(input.privateOperand, "synthetic-private-sentinel");
});

for (const defect of [
  "missing",
  "speech-probe",
  "python",
  "libc",
  "machine",
  "cpu-vendor",
  "cpu-number",
  "cpu-uniform",
  "package",
  "vad",
  "kernel",
  "hash",
  "newline",
]) {
  test(`numerical evidence rejects unverifiable or unbounded fields: ${defect}`, () => {
    const input = evidence();
    if (defect === "missing") delete input.synthetic;
    if (defect === "speech-probe") input.probe = "recorded-speech";
    if (defect === "python") input.python = "3.12.0";
    if (defect === "libc") input.libc.name = "unknown";
    if (defect === "machine") input.machine = "arm64";
    if (defect === "cpu-vendor") input.cpu.vendor = "unvalidated";
    if (defect === "cpu-number") input.cpu.model = "85";
    if (defect === "cpu-uniform") input.cpu.uniform = "true";
    if (defect === "package") input.packages.onnxruntime = "unknown";
    if (defect === "vad") input.vadGraphSha256 = "c".repeat(64);
    if (defect === "kernel") input.numpyKernels.log_float64 = "unknown";
    if (defect === "hash") input.synthetic.stftComplex64Sha256 = "unbounded diagnostic";
    if (defect === "newline") input.ctranslate2ExtensionSha256 += "\n";
    assert.throws(() => qualifyNumericalRuntime(input));
  });
}

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inferenceConfigurationSha256,
  qualifyNumericalRuntime,
} from "../../tools/asr/qualification.mjs";

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
    schemaVersion: 1,
    probe: "integer-ramp-pcm16-16000-v1",
    python: "3.11.16",
    libc: { name: "glibc", version: "2.39" },
    machine: "x86_64",
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
    if (defect === "package") input.packages.onnxruntime = "unknown";
    if (defect === "vad") input.vadGraphSha256 = "c".repeat(64);
    if (defect === "kernel") input.numpyKernels.log_float64 = "unknown";
    if (defect === "hash") input.synthetic.stftComplex64Sha256 = "unbounded diagnostic";
    if (defect === "newline") input.ctranslate2ExtensionSha256 += "\n";
    assert.throws(() => qualifyNumericalRuntime(input));
  });
}

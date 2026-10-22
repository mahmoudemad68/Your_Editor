/** Original ten-minute inference in the unchanged production image and resource jail. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { setTimeout, clearTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const root = path.resolve(import.meta.dirname, "../..");
const modelIdentities = {
  tiny: {
    name: "faster-whisper-tiny",
    version: "d90ca5fe260221311c53c58e660288d3deb8d356",
    sha256: "83ba3102b2fb621cef33d905bb6f8dc7db9c383743bce3cf510d2f5574862281",
  },
  small: {
    name: "faster-whisper-small",
    version: "536b0662742c02347bc0e980a01041f333bce120",
    sha256: "4e456821bbeabf0923f07220a86c1c14a8820bc83e78ae638d4474207b70aedd",
  },
};

function integer(value) {
  assert.ok(Number.isSafeInteger(value) && value >= 0, "Invalid bounded resource evidence");
  return value;
}

export function qualifyResources(before, after) {
  for (const value of [before, after]) {
    assert.equal(integer(value.cpuQuotaUs), 2 * integer(value.cpuPeriodUs));
    assert.ok(value.cpuPeriodUs > 0);
    assert.equal(integer(value.memoryLimitBytes), 3 * 1024 ** 3);
    assert.equal(integer(value.pidsLimit), 128);
    assert.ok(
      integer(value.memoryPeakBytes) > 0 && value.memoryPeakBytes <= value.memoryLimitBytes,
    );
    assert.ok(integer(value.logicalCpus) > 0 && integer(value.affinityCpus) > 0);
    assert.equal(integer(value.memoryEvents.oom_kill), 0);
  }
  const cpuDelta = {};
  for (const key of ["usage_usec", "nr_periods", "nr_throttled", "throttled_usec"]) {
    cpuDelta[key] = integer(after.cpu[key]) - integer(before.cpu[key]);
    assert.ok(cpuDelta[key] >= 0, "CPU counters must be monotonic");
  }
  assert.ok(
    cpuDelta.usage_usec > 0 && cpuDelta.nr_periods > 0,
    "Actual CPU accounting is required",
  );
  return {
    cpuQuota: 2,
    cpuPeriodUs: after.cpuPeriodUs,
    logicalCpus: after.logicalCpus,
    affinityCpus: after.affinityCpus,
    memoryLimitBytes: after.memoryLimitBytes,
    memoryPeakBytes: after.memoryPeakBytes,
    pidsLimit: 128,
    cpuDelta,
  };
}

export function qualifyWords(words) {
  assert.ok(Array.isArray(words) && words.length > 600);
  let previous = 0;
  const minutes = Array(10).fill(0);
  for (const word of words) {
    assert.equal(typeof word.text, "string");
    assert.ok(word.text.trim().length > 0);
    assert.match(word.startUs, /^(0|[1-9][0-9]*)$/);
    assert.match(word.endUs, /^(0|[1-9][0-9]*)$/);
    const start = Number(word.startUs),
      end = Number(word.endUs);
    assert.ok(Number.isSafeInteger(start) && Number.isSafeInteger(end));
    assert.equal(String(start), word.startUs);
    assert.equal(String(end), word.endUs);
    assert.ok(previous <= start && start < end && end <= 600000000);
    assert.ok(Number.isFinite(word.confidence) && word.confidence >= 0 && word.confidence <= 1);
    previous = end;
    minutes[Math.floor(start / 60000000)]++;
  }
  assert.ok(previous > 590000000 && minutes.every((count) => count > 30));
  return words.length;
}

function qualifyResult(result, model) {
  const worker = result.worker;
  assert.equal(worker.section.status, "completed");
  assert.deepEqual(result.versions, {
    numpy: "2.4.6",
    ctranslate2: "4.8.2",
    "faster-whisper": "1.2.1",
  });
  assert.deepEqual(worker.section.provenance.model, modelIdentities[model]);
  const settings = worker.inferenceParameters;
  for (const [key, expected] of Object.entries({
    model,
    cpu_threads: 2,
    workers: 1,
    timeout_ms: 600000,
    beam_size: 5,
    temperature: 0,
    seed: 0,
    effectiveDevice: "cpu",
    effectiveComputeType: "int8",
    nativeCpuProfile: "onednn-avx2-strict-v4",
    alignmentAlgorithm: "ct2-contextual-v27",
    numpyCpuProfile: "numpy-avx2-log-v2",
    numpyVersion: "2.4.6",
  }))
    assert.equal(settings[key], expected);
  assert.deepEqual(settings.numpyCpuKernels, {
    cos_float64: "X86_V3",
    absolute_complex64: "X86_V3",
    log_float64: "X86_V3",
  });
  assert.deepEqual(
    settings.alignmentFallbackModel,
    model === "tiny" ? modelIdentities.small : null,
  );
  assert.ok(
    Number.isFinite(worker.wallTimeMs) && worker.wallTimeMs > 0 && worker.wallTimeMs <= 600000,
  );
  assert.ok(integer(worker.peakRssBytes) > 0 && worker.peakRssBytes <= 3 * 1024 ** 3);
  const wordCount = qualifyWords(worker.section.data.segments.flatMap((segment) => segment.words));
  const phases = {};
  for (const key of [
    "_load",
    "_language_regions",
    "_decode_window",
    "_primary_aligned_chunk",
    "_fallback_alignment",
    "_reconcile_overlaps",
    "_recover_coverage",
  ]) {
    const value = result.phases?.[key];
    if (value) {
      assert.ok(integer(value.calls) > 0 && value.calls <= 100000);
      assert.ok(
        Number.isFinite(value.wallTimeMs) && value.wallTimeMs >= 0 && value.wallTimeMs <= 600000,
      );
      phases[key] = { calls: value.calls, wallTimeMs: value.wallTimeMs };
    }
  }
  assert.ok(phases._load && phases._language_regions && phases._decode_window);
  return {
    wallTimeMs: worker.wallTimeMs,
    peakRssBytes: worker.peakRssBytes,
    wordCount,
    resources: qualifyResources(result.before, result.after),
    phases,
  };
}

/** A failed/overflowing/timed-out run kills its container before reporting failure. */
async function captured(bin, args, { name, deadlineMs, maxBytes = 16000000 } = {}) {
  const child = spawn(bin, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const output = [],
    errors = [];
  let bytes = 0,
    errorBytes = 0,
    failed = false,
    timer;
  const kill = () => {
    if (failed) return;
    failed = true;
    if (name) {
      try {
        execFileSync("docker", ["rm", "-f", name], { timeout: 15000, stdio: "ignore" });
      } catch {
        /* failure remains fatal */
      }
    }
    child.kill("SIGKILL");
  };
  child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes) kill();
    else output.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    errorBytes += chunk.length;
    if (errorBytes > 1000000) kill();
    else errors.push(chunk);
  });
  if (deadlineMs) timer = setTimeout(kill, deadlineMs);
  try {
    const code = await new Promise((resolve) => {
      child.once("error", () => resolve(-1));
      child.once("close", resolve);
    });
    return {
      code: failed ? -1 : code,
      output: Buffer.concat(output).toString("utf8"),
      error: Buffer.concat(errors).toString("utf8"),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function main() {
  if (process.platform !== "linux")
    throw new Error("NOT_RUN_ON_WINDOWS: production Docker/cgroup qualification requires Linux");
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const checkoutSha = git(["rev-parse", "HEAD"]),
    treeSha = git(["rev-parse", "HEAD^{tree}"]);
  assert.match(checkoutSha, /^[a-f0-9]{40}$/);
  assert.match(treeSha, /^[a-f0-9]{40}$/);
  if (process.env.PR_HEAD_SHA) assert.match(process.env.PR_HEAD_SHA, /^[a-f0-9]{40}$/);
  const privateDir = path.join(root, ".local/asr-qualification", checkoutSha);
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  const inputs = await mkdtemp(path.join(tmpdir(), "editagent-original-asr-"));
  const driver = path.join(root, "tools/asr/qualification.py");
  assert.ok(!inputs.includes(",") && !driver.includes(","));
  const report = {
    checkoutSha,
    treeSha,
    prHeadSha: process.env.PR_HEAD_SHA ?? null,
    status: "FAIL",
    image: "editagent-ai-asr:test",
    models: { tiny: { status: "NOT_PROVEN" }, small: { status: "NOT_PROVEN" } },
    accuracy: "NOT_MEASURED: no independent 600-second word gold",
    cp2Status: "NOT_MET",
  };
  try {
    const prepared = await captured(
      "uv",
      [
        "run",
        "--frozen",
        "--project",
        "workers/ai-worker",
        "python",
        driver,
        "prepare",
        "--repository",
        root,
        "--directory",
        inputs,
      ],
      { deadlineMs: 90000 },
    );
    await writeFile(path.join(privateDir, "preparation.log"), prepared.error, { mode: 0o600 });
    assert.equal(prepared.code, 0, "Original approved PCM preparation failed");
    report.imageId = execFileSync(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}", report.image],
      { encoding: "utf8", timeout: 15000 },
    ).trim();
    assert.match(report.imageId, /^sha256:[a-f0-9]{64}$/);
    const original = await readFile(path.join(inputs, "audio.wav"));
    report.sourceIdentity = JSON.parse(await readFile(path.join(inputs, "identity.json"), "utf8"));
    report.sourceSha256 = createHash("sha256").update(original).digest("hex");
    for (const model of ["tiny", "small"]) {
      const measurements = [];
      report.models[model] = { status: "FAIL", measurements };
      let reference;
      for (let pass = 0; pass < 2; pass++) {
        const name = "asr-qualification-" + randomUUID();
        const started = performance.now();
        try {
          const run = await captured(
            "docker",
            [
              "run",
              "--name",
              name,
              "--network",
              "none",
              "--user",
              "10001:10001",
              "--init",
              "--read-only",
              "--cap-drop",
              "ALL",
              "--security-opt",
              "no-new-privileges:true",
              "--cpus",
              "2",
              "--memory",
              "3g",
              "--memory-swap",
              "3g",
              "--pids-limit",
              "128",
              "--tmpfs",
              "/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777",
              "--mount",
              `type=bind,src=${inputs},dst=/qualification,readonly`,
              "--mount",
              `type=bind,src=${driver},dst=/qualification-driver.py,readonly`,
              "-e",
              `EDITAGENT_ASR_MODEL=${model}`,
              "-e",
              "EDITAGENT_ASR_CPU_THREADS=2",
              "-e",
              "EDITAGENT_ASR_TIMEOUT_MS=600000",
              report.image,
              "python",
              "/qualification-driver.py",
              "measure",
            ],
            { name, deadlineMs: 600000 },
          );
          await writeFile(path.join(privateDir, `${model}-${pass}-native.json`), run.output, {
            mode: 0o600,
            flag: "wx",
          });
          await writeFile(path.join(privateDir, `${model}-${pass}-native.log`), run.error, {
            mode: 0o600,
            flag: "wx",
          });
          assert.equal(run.code, 0, "Production original inference failed");
          const result = JSON.parse(run.output);
          measurements.push({
            ...qualifyResult(result, model),
            containerWallTimeMs: performance.now() - started,
          });
          if (reference) {
            // Full actual native objects, including ordered words/confidence/provenance.
            assert.deepEqual(result.worker.section, reference.section);
            assert.deepEqual(result.worker.inferenceParameters, reference.inferenceParameters);
          } else reference = result.worker;
        } finally {
          execFileSync("docker", ["rm", "-f", name], { timeout: 15000, stdio: "ignore" });
        }
      }
      report.models[model] = {
        status: "PASS",
        model: modelIdentities[model],
        alignmentFallbackModel: model === "tiny" ? modelIdentities.small : null,
        runtimeVersions: { numpy: "2.4.6", ctranslate2: "4.8.2", "faster-whisper": "1.2.1" },
        nativeProfile: "onednn-avx2-strict-v4",
        numpyProfile: "numpy-avx2-log-v2",
        numpyKernels: {
          cos_float64: "X86_V3",
          absolute_complex64: "X86_V3",
          log_float64: "X86_V3",
        },
        cpuThreads: 2,
        workers: 1,
        computeType: "int8",
        beamSize: 5,
        temperature: 0,
        seed: 0,
        inferenceDeadlineMs: 600000,
        freshProcessFullOutputExactlyEqual: true,
        phaseTiming:
          "Inclusive method wall times; nested phases are not additive; profiling overhead included",
        measurements,
      };
    }
    assert.equal(
      createHash("sha256")
        .update(await readFile(path.join(inputs, "audio.wav")))
        .digest("hex"),
      report.sourceSha256,
    );
    report.status = "PASS";
  } catch (error) {
    await writeFile(path.join(privateDir, "failure.txt"), String(error.stack ?? error), {
      mode: 0o600,
    });
  } finally {
    await rm(inputs, { recursive: true, force: true });
    await writeFile(path.join(privateDir, "report.json"), JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
  }
  // Explicit control/numeric fields above are freshly measured; native payloads stay private.
  console.info("ASR_PRODUCTION_10MIN", JSON.stringify(report));
  if (report.status !== "PASS")
    throw new Error("Production ten-minute qualification failed; native operands remain private");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(
      process.platform === "win32"
        ? "NOT_RUN_ON_WINDOWS: production Docker/cgroup qualification requires Linux"
        : "Production ten-minute qualification FAIL; details retained locally.",
    );
    process.exitCode = 1;
  });
}

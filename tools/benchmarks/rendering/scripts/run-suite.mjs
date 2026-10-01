import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import path from "node:path";
import { benchmarkRoot, loadSpec } from "./load-spec.mjs";
import { ensureBrowser } from "@remotion/renderer";
import { probeFile } from "./probe.mjs";
import { startSampler } from "./resources.mjs";

delete process.env.LD_LIBRARY_PATH;

const root = benchmarkRoot();
const spec = loadSpec();
const outDir = path.join(root, "out");
mkdirSync(outDir, { recursive: true });
mkdirSync(path.join(root, "results"), { recursive: true });

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return (result.stdout || result.stderr || "").trim();
}

function machine() {
  const cpuinfo = readFileSync("/proc/cpuinfo", "utf8");
  const model = cpuinfo.match(/^model name\s*:\s*(.+)$/m)?.[1] ?? "unknown";
  const meminfo = readFileSync("/proc/meminfo", "utf8");
  const memKb = Number(meminfo.match(/^MemTotal:\s+(\d+)/m)?.[1] ?? 0);
  return {
    os: commandOutput("bash", ["-lc", '. /etc/os-release && printf %s "$PRETTY_NAME"']),
    kernel: commandOutput("uname", ["-sr"]),
    cpuModel: model,
    logicalCores: cpus().length,
    totalRamBytes: memKb * 1024 || totalmem(),
    gpu: "none detected (nvidia-smi is not installed)",
    disk: commandOutput("df", ["-hT", root]).split("\n").at(-1) ?? "",
    blockDevices: commandOutput("lsblk", ["-d", "-o", "NAME,ROTA,TYPE,SIZE,MODEL"]),
    node: process.version,
    pnpm: commandOutput("pnpm", ["-v"]),
    ffmpeg: commandOutput("ffmpeg", ["-version"]).split("\n")[0] ?? "",
    chromium: browserVersion,
    ffprobe: commandOutput("ffprobe", ["-version"]).split("\n")[0] ?? "",
    docker: commandOutput("docker", ["version", "--format", "{{.Server.Version}}"]),
    hardwareAcceleration: spec.hardwareAcceleration,
    encoder: spec.encoder,
    x264Preset: spec.x264Preset,
    crf: spec.crf,
  };
}

function runProcess(command, args, label) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
    const sampler = startSampler(child.pid);
    child.on("error", reject);
    child.on("exit", (code) => {
      const resources = sampler.stop();
      resolve({
        label,
        exitCode: code ?? 1,
        wallSeconds: Number(process.hrtime.bigint() - started) / 1e9,
        startupSeconds: null,
        bundleSeconds: null,
        renderSeconds: null,
        firstFrameSeconds: null,
        ...resources,
      });
    });
  });
}

function summarize(runs) {
  const measured = runs.filter((run) => run.label.startsWith("measured-") && run.valid);
  const walls = measured.map((run) => run.wallSeconds);
  const sorted = [...walls].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length === 0
      ? null
      : sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
  return {
    runs: measured.length,
    minSeconds: sorted[0] ?? null,
    medianSeconds: median,
    maxSeconds: sorted.at(-1) ?? null,
    peakRssBytes: measured.reduce((peak, run) => Math.max(peak, run.peakRssBytes), 0),
    browserPeakRssBytes: measured.reduce(
      (peak, run) => Math.max(peak, run.browserPeakRssBytes ?? 0),
      0,
    ),
    renderSecondsPerOutputSecond: median === null ? null : median / spec.durationSeconds,
    realtimeFactor: median === null ? null : spec.durationSeconds / median,
  };
}

async function benchmark(name, command) {
  const labels = ["cold", "warmup", "measured-1", "measured-2", "measured-3"];
  const runs = [];
  for (const label of labels) {
    const output = path.join(outDir, `${name}-${label}.mp4`);
    const mode = label === "cold" ? "cold" : "warm";
    const measured = await runProcess("node", [...command, output, mode], label);
    let metrics;
    try {
      metrics = JSON.parse(readFileSync(`${output}.metrics.json`, "utf8"));
    } catch {
      metrics = {};
    }
    const merged = {
      ...measured,
      wallSeconds: metrics.wallSeconds ?? measured.wallSeconds,
      startupSeconds: metrics.startupSeconds ?? null,
      bundleSeconds: metrics.bundleSeconds ?? null,
      renderSeconds: metrics.renderSeconds ?? null,
      firstFrameSeconds: metrics.firstFrameSeconds ?? null,
      browserExecutable: metrics.browserExecutable ?? null,
      peakRssBytes: Math.max(measured.peakRssBytes, metrics.peakRssBytes ?? 0),
      browserPeakRssBytes: Math.max(
        measured.browserPeakRssBytes ?? 0,
        metrics.browserPeakRssBytes ?? 0,
      ),
      cpuSeconds: metrics.cpuSeconds ?? measured.cpuSeconds,
    };
    const validation =
      merged.exitCode === 0 ? probeFile(output) : { ok: false, problems: ["exit"] };
    merged.valid = validation.ok === true;
    merged.output = validation;
    runs.push(merged);
    process.stdout.write(
      `${name} ${label}: ${merged.wallSeconds.toFixed(3)}s valid=${merged.valid}\n`,
    );
  }
  return { runs, summary: summarize(runs) };
}

const fixture = spawnSync("node", ["scripts/generate-fixture.mjs"], {
  cwd: root,
  stdio: "inherit",
});
if (fixture.status !== 0) {
  process.exit(fixture.status ?? 1);
}
const browser = await ensureBrowser();
const browserPath =
  browser.type === "no-browser" || browser.type === "version-mismatch" ? null : browser.path;
const browserVersion =
  browserPath === null ? browser.type : commandOutput(browserPath, ["--version"]) || browserPath;

const ffmpegCut = await benchmark("ffmpeg-cut-concat", ["scripts/ffmpeg-cut-concat.mjs"]);
const ffmpegDecorated = await benchmark("ffmpeg-decorated", ["scripts/ffmpeg-decorated.mjs"]);
const remotion = await benchmark("remotion", ["scripts/remotion-render.mjs"]);
const remotionMedian = remotion.summary.medianSeconds;
const summary = {
  generatedAt: new Date().toISOString(),
  referenceMachine: "NOT_VERIFIED",
  cp1: {
    outputSeconds: spec.durationSeconds,
    limitSeconds: 300,
    referenceMachine: "NOT_VERIFIED",
    provisionalMedianSeconds: remotionMedian,
    provisionalPass: remotionMedian !== null && remotionMedian <= 300,
  },
  spec,
  machine: machine(),
  strategies: {
    "ffmpeg-cut-concat": ffmpegCut,
    "ffmpeg-decorated": ffmpegDecorated,
    remotion,
  },
};
writeFileSync(path.join(root, "results", "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`wrote ${path.join(root, "results", "summary.json")}\n`);

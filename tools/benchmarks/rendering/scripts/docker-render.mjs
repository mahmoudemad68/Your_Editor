import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  classifyChromiumSandbox,
  readLiveChromiumArgv,
  readProcessStartTime,
} from "./chromium-sandbox.mjs";
import { benchmarkRoot } from "./load-spec.mjs";
import { probeFile } from "./probe.mjs";

const root = benchmarkRoot();
const output = path.join(root, "out", "docker-remotion.mp4");
const fixture = spawnSync("node", ["scripts/generate-fixture.mjs"], {
  cwd: root,
  stdio: "inherit",
});
if (fixture.status !== 0) {
  process.exit(fixture.status ?? 1);
}

const started = process.hrtime.bigint();
const rendered = spawn("node", ["scripts/remotion-render.mjs", output, "warm"], {
  cwd: root,
  stdio: "inherit",
});
const rendererPid = Number.isInteger(rendered.pid) ? rendered.pid : null;
const rendererStartTime = rendererPid === null ? null : readProcessStartTime(rendererPid);
let latestObservation = {
  inspected: false,
  rendererPid: rendererPid ?? undefined,
  reason:
    rendererPid === null
      ? "renderer PID is unavailable"
      : "no Chromium process descending from the renderer was observed",
};
const watcher = setInterval(() => {
  const observation = readLiveChromiumArgv({ rendererPid, rendererStartTime });
  if (observation.inspected === true) {
    latestObservation = observation;
  }
}, 200);

let exitCode;
try {
  exitCode = await new Promise((resolve, reject) => {
    rendered.on("error", reject);
    rendered.on("exit", (code) => resolve(code ?? 1));
  });
} finally {
  clearInterval(watcher);
}
const wallSeconds = Number(process.hrtime.bigint() - started) / 1e9;
let metrics;
try {
  metrics = JSON.parse(readFileSync(`${output}.metrics.json`, "utf8"));
} catch {
  metrics = {};
}
const validation = exitCode === 0 ? probeFile(output) : { ok: false, problems: ["exit"] };
const record = {
  exitCode,
  wallSeconds,
  metrics,
  validation,
  user: process.getuid?.() ?? null,
  chromiumSandbox: classifyChromiumSandbox(latestObservation),
};
writeFileSync(path.join(root, "results", "docker.json"), `${JSON.stringify(record, null, 2)}\n`);
process.exit(validation.ok ? 0 : 1);

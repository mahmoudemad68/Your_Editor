import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  SANDBOX_DISABLE_FLAGS,
  classifyChromiumSandbox,
  readLiveChromiumArgv,
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
let latestObservation = { inspected: false, reason: "no Chromium process was observed" };
const disablingFlagCount = (argv) =>
  SANDBOX_DISABLE_FLAGS.filter((flag) => argv.includes(flag)).length;
const watcher = setInterval(() => {
  const observation = readLiveChromiumArgv();
  if (observation.inspected !== true) {
    return;
  }
  const previousCount =
    latestObservation.inspected === true ? disablingFlagCount(latestObservation.argv) : -1;
  if (disablingFlagCount(observation.argv) >= previousCount) {
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

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
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
const rendered = spawnSync("node", ["scripts/remotion-render.mjs", output, "warm"], {
  cwd: root,
  stdio: "inherit",
});
const wallSeconds = Number(process.hrtime.bigint() - started) / 1e9;
let metrics;
try {
  metrics = JSON.parse(readFileSync(`${output}.metrics.json`, "utf8"));
} catch {
  metrics = {};
}
const validation = rendered.status === 0 ? probeFile(output) : { ok: false, problems: ["exit"] };
const record = {
  exitCode: rendered.status,
  wallSeconds,
  metrics,
  validation,
  user: process.getuid?.() ?? null,
  sandboxDisabled: false,
};
writeFileSync(path.join(root, "results", "docker.json"), `${JSON.stringify(record, null, 2)}\n`);
process.exit(validation.ok ? 0 : 1);

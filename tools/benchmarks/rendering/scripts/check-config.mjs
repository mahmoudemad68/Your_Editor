import { readFileSync } from "node:fs";
import path from "node:path";
import { benchmarkRoot, loadCaptions, loadSpec } from "./load-spec.mjs";

const spec = loadSpec();
const captions = loadCaptions();
const problems = [];
if (spec.width !== 1080 || spec.height !== 1920) {
  problems.push("resolution");
}
if (spec.fps !== 30 || spec.durationSeconds !== 60) {
  problems.push("timeline");
}
if (spec.videoCodec !== "h264" || spec.pixelFormat !== "yuv420p" || spec.audioCodec !== "aac") {
  problems.push("codecs");
}
if (spec.hardwareAcceleration !== false || spec.encoder !== "libx264") {
  problems.push("encoder");
}
if (captions.length < 2 || captions[0].start !== 0 || captions.at(-1).end !== 60) {
  problems.push("captions");
}
const summaryPath = path.join(benchmarkRoot(), "results", "summary.json");
const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
if (summary.cp1.referenceMachine !== "NOT_VERIFIED" || summary.cp1.limitSeconds !== 300) {
  problems.push("cp1");
}
for (const name of ["ffmpeg-cut-concat", "ffmpeg-decorated", "remotion"]) {
  const measured = summary.strategies[name].runs.filter(
    (run) => run.label.startsWith("measured-") && run.valid,
  );
  if (measured.length < 3) {
    problems.push(`${name} measured runs`);
  }
}
if (problems.length > 0) {
  process.stderr.write(`${problems.join(", ")}\n`);
  process.exit(1);
}
process.stdout.write("benchmark config ok\n");

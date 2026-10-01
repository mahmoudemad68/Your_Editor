import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve("tools/benchmarks/rendering");

test("the rendering spike spec is a 60-second 1080x1920 composition", () => {
  const spec = JSON.parse(readFileSync(path.join(root, "spec.json"), "utf8"));
  assert.equal(spec.width, 1080);
  assert.equal(spec.height, 1920);
  assert.equal(spec.fps, 30);
  assert.equal(spec.durationSeconds, 60);
  assert.equal(spec.videoCodec, "h264");
  assert.equal(spec.pixelFormat, "yuv420p");
  assert.equal(spec.audioCodec, "aac");
  assert.equal(spec.hardwareAcceleration, false);
  assert.equal(spec.encoder, "libx264");
  const captions = JSON.parse(readFileSync(path.join(root, "captions.json"), "utf8"));
  assert.equal(captions[0].start, 0);
  assert.equal(captions.at(-1).end, 60);
});

test("recorded rendering results stay tied to the report and do not claim the reference machine", () => {
  const summary = JSON.parse(readFileSync(path.join(root, "results/summary.json"), "utf8"));
  const report = readFileSync(path.join("docs/research/technology-evaluation.md"), "utf8");
  assert.equal(summary.cp1.limitSeconds, 300);
  assert.equal(summary.cp1.outputSeconds, 60);
  assert.equal(summary.cp1.referenceMachine, "NOT_VERIFIED");
  assert.match(report, /NOT_VERIFIED/);
  assert.match(report, /300/);
  for (const name of ["ffmpeg-cut-concat", "ffmpeg-decorated", "remotion"]) {
    const measured = summary.strategies[name].runs.filter(
      (run) => String(run.label).startsWith("measured-") && run.valid === true,
    );
    assert.equal(measured.length >= 3, true, name);
    const median = summary.strategies[name].summary.medianSeconds;
    assert.equal(Number.isFinite(median), true, name);
    assert.match(report, new RegExp(median.toFixed(3)));
  }
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.equal(workflow.includes("run-suite.mjs"), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRenderInput, outputKey, progressPercentage, canonicalJson } from "./contract.js";
import { loadRenderWorkerConfig, loadRendererProcessConfig } from "./config.js";
import { exactEncoderTiming } from "./encoder-timing.js";
const id = "018fe277-6ec0-7000-8000-000000000001";
const base = {
  schemaVersion: 1,
  renderVersion: "a".repeat(64),
  compositionId: "FixtureV1",
  width: 320,
  height: 180,
  frameRate: { numerator: 30, denominator: 1 },
  durationInFrames: 150,
  props: { title: "مرحبا 👋", background: "#16324f" },
  correlationId: "render-test",
};
test("supported SDK encoder hook retains exact rational timebase without mutable or injectable argv", () => {
  const args = [
    "-framerate",
    "2997003/100000",
    "-i",
    "remotion",
    "-video_track_timescale",
    "90000",
    "-y",
    "/tmp/output.mp4",
  ];
  const before = [...args];
  assert.deepEqual(exactEncoderTiming(args, { numerator: 30000, denominator: 1001 }), [
    "-framerate",
    "30000/1001",
    "-i",
    "remotion",
    "-video_track_timescale",
    "30000",
    "-y",
    "/tmp/output.mp4",
  ]);
  assert.deepEqual(args, before);
  assert.deepEqual(
    exactEncoderTiming(["-i", "/tmp/input.mp4", "-c:v", "copy", "/tmp/output.mp4"], {
      numerator: 24,
      denominator: 1,
    }),
    ["-i", "/tmp/input.mp4", "-c:v", "copy", "-video_track_timescale", "24", "/tmp/output.mp4"],
  );
  for (const numerator of [NaN, Infinity, 0, -1, 1.2, 60001])
    assert.throws(() => exactEncoderTiming(args, { numerator, denominator: 1 }));
  assert.throws(() => exactEncoderTiming(["-r", "30"], { numerator: 30, denominator: 1 }));
});
test("strict bounded render payload preserves Unicode and rejects executable/URL/path injection", () => {
  assert.deepEqual(parseRenderInput(base), base);
  for (const p of [
    { ...base, code: "alert(1)" },
    { ...base, compositionId: "file:///etc/passwd" },
    { ...base, width: 0 },
    { ...base, height: 16384 },
    { ...base, width: 320.5 },
    { ...base, width: Infinity },
    { ...base, durationInFrames: 0 },
    { ...base, durationInFrames: 108001 },
    { ...base, frameRate: { numerator: NaN, denominator: 1 } },
    { ...base, frameRate: { numerator: 61, denominator: 1 } },
    { ...base, props: { ...base.props, url: "http://169.254.169.254" } },
    { ...base, props: { ...base.props, title: "\ud800" } },
    { ...base, props: { ...base.props, title: " " } },
    { ...base, props: { ...base.props, title: "x".repeat(201) } },
    JSON.parse(JSON.stringify(base).replace('"title":', '"__proto__":{},"title":')),
  ])
    assert.throws(() => parseRenderInput(p));
});
test("rational fps and bounded duration are admitted without accumulated frame drift", () => {
  const p = { ...base, frameRate: { numerator: 30000, denominator: 1001 }, durationInFrames: 150 };
  assert.deepEqual(parseRenderInput(p), p);
  assert.throws(() =>
    parseRenderInput({
      ...base,
      frameRate: { numerator: 1, denominator: 1 },
      durationInFrames: 1801,
    }),
  );
});
test("output identity is deterministic, namespaced, canonical and not caller controlled", () => {
  const key = outputKey(base.renderVersion, id, id);
  assert.equal(key, `renders/${base.renderVersion}/${id}/${id}.mp4`);
  for (const hostile of ["../etc", "-o", "http://evil", "\0", id.toUpperCase()])
    assert.throws(() => outputKey(base.renderVersion, hostile, id));
  assert.equal(canonicalJson({ b: 1, a: [2, 3] }), canonicalJson({ a: [2, 3], b: 1 }));
});
test("frame progress is monotonic/bounded and defers completion until validation/upload", () => {
  let previous = 0;
  for (const n of [0, 1, 30, 25, 1000]) {
    const next = progressPercentage(
      { renderedFrames: n, encodedFrames: n, totalFrames: 150 },
      previous,
    );
    assert.ok(next >= previous && next >= 0 && next <= 95);
    previous = next;
  }
  assert.throws(() =>
    progressPercentage({ renderedFrames: NaN, encodedFrames: 0, totalFrames: 1 }),
  );
  assert.throws(() => progressPercentage({ renderedFrames: 0, encodedFrames: 0, totalFrames: 0 }));
});
test("render timeout and queue configuration fail closed", () => {
  const env = {
    DATABASE_URL: "postgresql://test:test@localhost/test",
    REDIS_URL: "redis://localhost",
    S3_ENDPOINT: "http://localhost:9000",
    S3_BUCKET: "test",
    S3_ACCESS_KEY_ID: "test",
    S3_SECRET_ACCESS_KEY: "test",
    S3_REGION: "us-east-1",
  };
  assert.equal(loadRenderWorkerConfig(env).renderTimeoutMs, 300000);
  for (const value of ["NaN", "Infinity", "0", "-1", "1.2", "600001"])
    assert.throws(() => loadRenderWorkerConfig({ ...env, EDITAGENT_RENDER_TIMEOUT_MS: value }));
  assert.throws(() => loadRenderWorkerConfig({ ...env, EDITAGENT_RENDER_QUEUE: "../queue" }));
});

test("renderer configuration stays in its boundary and fails closed on credentials or browser substitution", () => {
  assert.deepEqual(loadRendererProcessConfig({}), {
    concurrency: 2,
    browserExecutable: "/opt/chromium/chrome-headless-shell-linux64/chrome-headless-shell",
    path: "/usr/bin:/bin",
  });
  assert.equal(loadRendererProcessConfig({ REMOTION_CONCURRENCY: "4" }).concurrency, 4);
  for (const value of ["0", "5", "1.5", "NaN", "Infinity"])
    assert.throws(() => loadRendererProcessConfig({ REMOTION_CONCURRENCY: value }));
  for (const key of ["DATABASE_URL", "REDIS_URL", "AWS_REGION", "S3_BUCKET", "AUTH_SECRET"])
    assert.throws(() => loadRendererProcessConfig({ [key]: "forbidden" }));
  assert.throws(() => loadRendererProcessConfig({ REMOTION_BROWSER: "/tmp/other-browser" }));
  assert.throws(() => loadRendererProcessConfig({ PATH: "bad\0path" }));
});

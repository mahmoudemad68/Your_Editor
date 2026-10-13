import assert from "node:assert/strict";
import { test } from "node:test";
import { FfmpegExecutor } from "./ffmpeg-executor.js";
import { localMediaPath, validateFilterGraph } from "./ffmpeg-builder.js";
import { buildDerivativePreset } from "./ffmpeg-presets.js";
import { buildCutRenderArgs } from "./ffmpeg-cuts.js";
test("QA42 F1 per-filter keys and values reject network/sink/option/resource payloads", async () => {
  const bad = [
    "ebur128=metadata=1:video=1",
    "ebur128=peak=true:framelog=info:video=1",
    "scale=320:180:eval=frame",
    "aresample=16000:out_channel_layout=/etc/passwd",
    "silencedetect=noise=-60dB:d=NaN",
    "trim=start=0:end=-1",
    "fps=60000",
    "setsar=1:evil=1",
    "loudnorm=I=-23:LRA=7:TP=-1:print_format=/tmp/secret",
    "pad=320:180:(ow-iw)/2:(oh-ih)/2:color=movie",
    "color=c=red:s=99999x1:r=30",
    "concat=n=100000:v=1:a=1",
    "afade=t=in:ss=0:ns=0:curve=tri",
    "afade=t=out:ss=0:ns=241:curve=tri",
    "afade=t=in:ss=0:ns=240:curve=tri:filename=/etc/passwd",
    "afade=t=in:ss=0:ns=240:curve=tri;amovie=/etc/passwd",
  ];
  for (const graph of bad) {
    assert.throws(() => validateFilterGraph(graph));
    let spawned = false;
    await assert.rejects(
      new FfmpegExecutor().execute(
        ["-protocol_whitelist", "file", "-i", "/tmp/source", "-vf", graph, "-f", "null", "-"],
        {
          timeoutMs: 1000,
          onProcess: () => {
            spawned = true;
          },
        },
      ),
    );
    assert.equal(spawned, false);
  }
});
test("QA42 F2 protocol-shaped absolute paths fail without banning harmless punctuation", () => {
  for (const scheme of [
    "concat",
    "crypto",
    "file",
    "pipe",
    "http",
    "https",
    "ftp",
    "udp",
    "tcp",
    "data",
    "evil",
  ])
    assert.throws(() => localMediaPath(`/tmp/${scheme}:payload`));
  for (const file of ["/tmp/colon:payload", "/x/concat:a|b"])
    assert.throws(() => localMediaPath(file));
  assert.equal(
    localMediaPath("/tmp/quote'colon:comma,semi;[a]\\.wav"),
    "/tmp/quote'colon:comma,semi;[a]\\.wav",
  );
});
test("frozen derivative recipes remain accepted by strict filter policy", () => {
  for (const variant of ["proxy", "asr", "mix", "poster", "sprite"] as const) {
    const args = buildDerivativePreset("/tmp/source", "/tmp/out", {
      variant,
      parameters: {
        sourceDurationUs: "5000000",
        timestampUs: 2500000,
        timestampsUs: [0, 2500000],
        columns: 2,
        rows: 1,
      },
    });
    for (let i = 0; i < args.length; i++)
      if (args[i] === "-vf" || args[i] === "-af") validateFilterGraph(args[i + 1]!);
  }
});
test("historical midpoint sprites retain bounded sub-one-fps and midpoint-start syntax", () => {
  const legacy =
    "tpad=stop_mode=clone:stop_duration=5,fps=1/2:start_time=1:round=near," +
    "scale=w='max(2,trunc(iw*sar/2)*2)':h=ih,setsar=1," +
    "scale=160:90:force_original_aspect_ratio=decrease," +
    "pad=160:90:(ow-iw)/2:(oh-ih)/2,tile=1x1:nb_frames=1";
  assert.doesNotThrow(() => validateFilterGraph(legacy));
  assert.doesNotThrow(() => validateFilterGraph("fps=20/1800:start_time=45:round=near"));
  for (const value of [
    "fps=21/2:start_time=1:round=near",
    "fps=1/0:start_time=0:round=near",
    "fps=1/0.001:start_time=0:round=near",
    "fps=1/1801:start_time=1:round=near",
    "fps=1/2:start_time=-1:round=near",
    "fps=1/2:start_time=1801:round=near",
    "fps=1/2:start_time=movie:round=near",
    "fps=1/2:start_time=1:round=near:evil=1",
    "fps=fps=1/2:start_time=0:round=near",
  ])
    assert.throws(() => validateFilterGraph(value), value);
});
test("cut recipe is deterministic, rational, bounded and has no caller graph/URL capability", () => {
  const recipe = {
    segments: [
      {
        path: "/tmp/source",
        fromFrame: 0,
        frames: 10,
        sourceStartUs: 333667n,
        sourceEndUs: 667333n,
        hasAudio: true,
      },
    ],
    width: 320,
    height: 180,
    frameRate: { numerator: 30000, denominator: 1001 },
    totalFrames: 10,
    background: "#000000",
    output: "/tmp/output.mp4",
  };
  const args = buildCutRenderArgs(recipe);
  assert.deepEqual(args, buildCutRenderArgs(recipe));
  assert.ok(args.includes("30000/1001"));
  assert.match(args[args.indexOf("-filter_complex") + 1]!, /trim=start_frame=10:end_frame=20/);
  assert.throws(
    () =>
      buildCutRenderArgs({
        ...recipe,
        totalFrames: 45001,
        frameRate: { numerator: 25, denominator: 1 },
      }),
    /duration budget/,
  );
  for (const path of ["https://bad/input", "/tmp/file:/etc/passwd", "/tmp/concat:a|b"])
    assert.throws(() =>
      buildCutRenderArgs({ ...recipe, segments: [{ ...recipe.segments[0]!, path }] }),
    );
});
test("deterministic hostile option corpus cannot expand a permitted filter", () => {
  const fragments = [":", ",", ";", "[", "]", "'", '"', "\\", "\n", "-i", "movie", "http://"];
  for (const a of fragments)
    for (const b of fragments) {
      const payload = `${a}payload${b}`;
      assert.throws(() => validateFilterGraph(`silencedetect=noise=${payload}:d=0.2`));
      assert.throws(() => validateFilterGraph(`loudnorm=I=-23:LRA=7:TP=${payload}`));
      assert.throws(() => validateFilterGraph(`crop=w=32:h=32:x=${payload}:y=0`));
    }
});

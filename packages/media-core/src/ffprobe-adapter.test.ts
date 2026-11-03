import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MediaProbeError } from "@editagent/domain";
import {
  buildFfprobeArgs,
  FFprobeMediaProbe,
  parseDecodedVideoFrameCount,
} from "./ffprobe-adapter.js";

const media = path.resolve(__dirname, "../fixtures/media");
const bin = path.resolve(__dirname, "../fixtures/bin");
const normal = path.join(media, "normal.mp4");

function code(error: unknown): string {
  assert.ok(error instanceof MediaProbeError);
  assert.equal(error.message, "Media inspection failed.");
  assert.equal(error.message.includes("probe failed"), false);
  return error.code;
}

test("ffprobe arguments are an array and keep the local path intact", () => {
  const filePath = path.join(tmpdir(), "clip;$(echo pwned).mp4");
  const args = buildFfprobeArgs(filePath);
  assert.equal(Array.isArray(args), true);
  assert.equal(args.includes("-protocol_whitelist"), true);
  assert.equal(args.includes("file"), true);
  assert.equal(args.at(-1), filePath);
  assert.equal(args.filter((a) => a === "-threads").length, 1);
  assert.equal(args[args.indexOf("-threads") + 1], "1");
  assert.ok(args.indexOf("-threads") < args.indexOf("-i"));
  assert.equal(
    args.some((argument) => argument.includes(" && ")),
    false,
  );
  assert.equal(args.join("\0").includes("shell"), false);
});

test("decoded frame census rejects metadata, malformed and excessive counts", () => {
  const doc = (value: unknown) => ({ streams: [{ codec_type: "video", nb_read_frames: value }] });
  assert.equal(parseDecodedVideoFrameCount(doc("25")), 25);
  assert.equal(parseDecodedVideoFrameCount(doc("108000")), 108000);
  for (const v of [undefined, null, "N/A", "0", "-1", "1.0", "1e2", "01", 25, "108001"])
    assert.throws(() => parseDecodedVideoFrameCount(doc(v)), MediaProbeError);
  for (const v of [
    null,
    {},
    { streams: [] },
    { streams: [doc("25").streams[0], doc("25").streams[0]] },
    { streams: [{ codec_type: "audio", nb_read_frames: "25" }] },
    { streams: [{ codec_type: "video", nb_frames: "25", nb_read_packets: "25" }] },
  ])
    assert.throws(() => parseDecodedVideoFrameCount(v), MediaProbeError);
});

test(
  "decoded frame census executes a full bounded decoder command and rejects error output",
  {
    skip:
      process.platform === "win32"
        ? "POSIX executable fixture; real decoding qualified on Linux"
        : false,
  },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "full-frame-census-"));
    const executable = path.join(directory, "probe");
    try {
      for (const error of [false, true]) {
        await writeFile(
          executable,
          `#!${process.execPath}\nconst a=process.argv.slice(2);if(!a.includes('-count_frames')||a.includes('-read_intervals')||a[a.indexOf('-threads')+1]!=='1'||a[a.indexOf('-err_detect')+1]!=='explode'||a[a.indexOf('-select_streams')+1]!=='v:0'||a.includes('-c:v'))process.exit(3);console.log(JSON.stringify({streams:[{codec_type:'video',nb_read_frames:'25'}]}));${error ? "console.error('decoder error');" : ""}\n`,
          { mode: 0o700 },
        );
        const probe = new FFprobeMediaProbe({ executable, timeoutMs: 2000, maxOutputBytes: 4096 });
        const result = probe.countDecodedVideoFrames({ filePath: normal });
        if (error) await assert.rejects(result, (e) => code(e) === "exit");
        else assert.equal(await result, 25);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("a filename with shell metacharacters is passed as one argument", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "editagent-probe-name-"));
  const filePath = path.join(directory, "clip;$(echo pwned).mp4");
  copyFileSync(normal, filePath);
  const result = await new FFprobeMediaProbe().inspect({ filePath });
  assert.equal(result.videoCodec, "h264");
  assert.equal(result.container, "MP4");
  const listing = spawnSync("ls", [directory], { encoding: "utf8" });
  assert.equal(listing.stdout.includes("pwned"), true);
});

test("real ffprobe matches the recorded fixture metadata", async () => {
  const probe = new FFprobeMediaProbe();
  const normalResult = await probe.inspect({ filePath: normal });
  assert.equal(await probe.countDecodedVideoFrames({ filePath: normal }), 25);
  assert.equal(normalResult.videoCodec, "h264");
  assert.equal(normalResult.audioCodec, "aac");
  assert.equal(normalResult.duration, 1_000_000n);
  assert.equal(normalResult.frameRateMode, "constant");
  assert.deepEqual(normalResult.frameRate, { numerator: 25n, denominator: 1n });

  const rotated = await probe.inspect({ filePath: path.join(media, "rotated.mov") });
  assert.equal(rotated.container, "MOV");
  assert.equal(rotated.rotation, 90);
  assert.equal(rotated.displayWidth, 240);
  assert.equal(rotated.displayHeight, 320);
  assert.equal(rotated.width, 320);
  assert.equal(rotated.height, 240);

  const vfr = await probe.inspect({ filePath: path.join(media, "vfr.mp4") });
  assert.equal(vfr.frameRateMode, "variable");
  assert.deepEqual(vfr.frameRate, { numerator: 125n, denominator: 9n });
  assert.equal(vfr.duration, 360_000n);

  const multi = await probe.inspect({ filePath: path.join(media, "multi.mp4") });
  assert.equal(multi.streams.length, 3);
  assert.equal(multi.sampleRate, 48000);
  const audio = await probe.inspect({ filePath: path.join(media, "audio.wav") });
  assert.equal(audio.audioCodec, "pcm_s16le");
  assert.equal(audio.frameRateMode, "unknown");
  const image = await probe.inspect({ filePath: path.join(media, "image.png") });
  assert.equal(image.container, "PNG");
  assert.equal(image.colorSpace, "gbr");
  assert.equal(image.duration, null);
});

test("ffprobe failures stay controlled", async () => {
  await assert.rejects(
    () =>
      new FFprobeMediaProbe({ executable: path.join(bin, "missing-ffprobe") }).inspect({
        filePath: normal,
      }),
    (error: unknown) => code(error) === "not_found",
  );
  const started = Date.now();
  await assert.rejects(
    () =>
      new FFprobeMediaProbe({ executable: path.join(bin, "sleep.js"), timeoutMs: 200 }).inspect({
        filePath: normal,
      }),
    (error: unknown) => code(error) === "timeout",
  );
  assert.ok(Date.now() - started < 3_000);
  await assert.rejects(
    () =>
      new FFprobeMediaProbe({ executable: path.join(bin, "fail.js") }).inspect({
        filePath: normal,
      }),
    (error: unknown) => code(error) === "exit",
  );
  await assert.rejects(
    () =>
      new FFprobeMediaProbe({ executable: path.join(bin, "invalid-json.js") }).inspect({
        filePath: normal,
      }),
    (error: unknown) => code(error) === "invalid_json",
  );
  await assert.rejects(
    () =>
      new FFprobeMediaProbe({
        executable: path.join(bin, "huge.js"),
        maxOutputBytes: 1024,
      }).inspect({ filePath: normal }),
    (error: unknown) => code(error) === "invalid_json",
  );
  await assert.rejects(
    () => new FFprobeMediaProbe().inspect({ filePath: "http://example.com/video.mp4" }),
    (error: unknown) => code(error) === "invalid_result",
  );
  await assert.rejects(
    () => new FFprobeMediaProbe().inspect({ filePath: path.join(media, "corrupt.mp4") }),
    (error: unknown) => code(error) === "invalid_result",
  );
});

test("cut capability fails closed for variable cadence, rotation and non-video input", async () => {
  const probe = new FFprobeMediaProbe();
  assert.equal(await probe.supportsCutRendering({ filePath: normal }), true);
  assert.equal(
    await probe.supportsCutRendering({ filePath: normal }, { numerator: 25, denominator: 1 }),
    true,
  );
  assert.equal(
    await probe.supportsCutRendering({ filePath: normal }, { numerator: 30, denominator: 1 }),
    false,
  );
  for (const name of ["vfr.mp4", "rotated.mov", "audio.wav", "image.png"])
    assert.equal(await probe.supportsCutRendering({ filePath: path.join(media, name) }), false);
});

test("probe cancellation reaps the subprocess instead of waiting for its deadline", async () => {
  const controller = new AbortController();
  const probe = new FFprobeMediaProbe({
    executable: path.join(bin, "sleep.js"),
    timeoutMs: 30_000,
  });
  const started = Date.now();
  const inspection = probe.inspect({ filePath: normal, signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 30);
  try {
    await assert.rejects(inspection, (error) => code(error) === "interrupted");
    assert.ok(Date.now() - started < 5_000);
  } finally {
    clearTimeout(timer);
  }
});

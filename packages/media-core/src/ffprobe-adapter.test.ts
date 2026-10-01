import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MediaProbeError } from "@editagent/domain";
import { buildFfprobeArgs, FFprobeMediaProbe } from "./ffprobe-adapter.js";

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
  assert.equal(
    args.some((argument) => argument.includes(" && ")),
    false,
  );
  assert.equal(args.join("\0").includes("shell"), false);
});

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

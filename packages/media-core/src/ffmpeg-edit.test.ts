import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  buildVideoEditArgs,
  editOutputTiming,
  buildLoudnessMeasureArgs,
  parseLoudnessMeasurement,
  type VideoEdit,
} from "./ffmpeg-edit.js";
import { FfmpegExecutor } from "./ffmpeg-executor.js";
import { FFprobeMediaProbe } from "./ffprobe-adapter.js";
test("fixed media edits bound dimensions, speed, audio and malformed measurements", () => {
  const source = {
    path: "/tmp/source.mp4",
    width: 160,
    height: 90,
    durationUs: 2000000n,
    frameRate: { numerator: 30000, denominator: 1001 },
    hasAudio: true,
    audioSamples: 96000n,
  };
  for (const edit of [
    { operation: "crop_video", x: 1, y: 0, width: 32, height: 32 },
    { operation: "resize_video", width: 99999, height: 64 },
    { operation: "change_speed", numerator: 16, denominator: 1 },
  ] as VideoEdit[])
    assert.throws(() => editOutputTiming(source, edit));
  assert.throws(() =>
    editOutputTiming(
      { ...source, hasAudio: false },
      { operation: "normalize_audio", targetLufs: -23, truePeakDb: -1, loudnessRange: 7 },
    ),
  );
  for (const value of ["", '{"input_i":"-inf"}', '{"input_i":"NaN"}'])
    assert.throws(() => parseLoudnessMeasurement(value));
  for (const ratio of [
    [1, 4],
    [1, 2],
    [2, 1],
    [4, 1],
  ])
    assert.ok(
      buildVideoEditArgs(
        source,
        { operation: "change_speed", numerator: ratio[0]!, denominator: ratio[1]! },
        "/tmp/output.mp4",
      ).includes("-af"),
    );
});
test("spatial audio clocks are mandatory, bounded, independent, and never padded", () => {
  const source = {
    path: "/tmp/source.mp4",
    width: 64,
    height: 64,
    durationUs: 6472000n,
    frameRate: { numerator: 30000, denominator: 1001 },
    frameCount: 179,
    hasAudio: true,
  };
  for (const operation of ["crop_video", "resize_video"] as const) {
    const edit =
      operation === "crop_video"
        ? { operation, x: 0, y: 0, width: 32, height: 32 }
        : { operation, width: 128, height: 128 };
    assert.throws(() => buildVideoEditArgs(source, edit, "/tmp/output.mp4"), /audio clock/);
    for (const audioSamples of [-1n, 0n, 86400001n, 500000n, "310656", NaN, Infinity])
      assert.throws(() =>
        editOutputTiming({ ...source, audioSamples: audioSamples as bigint }, edit),
      );
    const args = buildVideoEditArgs({ ...source, audioSamples: 310656n }, edit, "/tmp/output.mp4");
    const filter = args[args.indexOf("-af") + 1]!;
    assert.match(filter, /atrim=end_sample=310656/);
    assert.doesNotMatch(filter, /apad/);
    assert.ok(!args.includes("-shortest"));
    assert.equal(editOutputTiming({ ...source, audioSamples: 240000n }, edit).totalFrames, 179);
  }
});
test(
  "fractional-rate resize preserves the inspected 179-frame count across microsecond rounding",
  { timeout: 30000 },
  async () => {
    const work = await mkdtemp(path.join(tmpdir(), "resize-frame-count-"));
    try {
      const file = path.join(work, "179.mp4");
      execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=s=64x64:r=30000/1001",
          "-frames:v",
          "179",
          "-c:v",
          "libx264",
          "-threads",
          "1",
          "-pix_fmt",
          "yuv420p",
          "-bf",
          "3",
          "-video_track_timescale",
          "30000",
          file,
        ],
        { timeout: 15000 },
      );
      const video = (await new FFprobeMediaProbe().inspectStreamTiming({ filePath: file })).find(
        (s) => s.kind === "video",
      )!;
      assert.equal(video.frames, 179n);
      const source = {
        path: file,
        width: 64,
        height: 64,
        durationUs: 5972634n,
        frameRate: { numerator: 30000, denominator: 1001 },
        frameCount: Number(video.frames),
        hasAudio: false,
      };
      const edit = { operation: "resize_video" as const, width: 128, height: 128 };
      assert.equal(editOutputTiming(source, edit).totalFrames, 179);
      assert.throws(
        () => editOutputTiming({ ...source, durationUs: 5900000n }, edit),
        /inconsistent/,
      );
      assert.equal(editOutputTiming({ ...source, durationUs: 6000000n }, edit).totalFrames, 179);
      const output = path.join(work, "resize.mp4");
      await new FfmpegExecutor().execute(buildVideoEditArgs(source, edit, output), {
        timeoutMs: 15000,
      });
      const resized = (
        await new FFprobeMediaProbe().inspectStreamTiming({ filePath: output })
      ).find((s) => s.kind === "video")!;
      assert.equal(resized.frames, 179n);
      assert.equal(resized.durationTicks, 179179n);
      const decoded = execFileSync(
        "ffmpeg",
        ["-v", "error", "-i", output, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        { maxBuffer: 10000000, timeout: 15000 },
      );
      assert.equal(decoded.length, 179 * 128 * 128 * 3);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);
test(
  "real crop, resize, both speed directions and two-pass loudness create deterministic playable MP4 without source mutation",
  { timeout: 60000 },
  async (t) => {
    const work = await mkdtemp(path.join(tmpdir(), "media-edit-")),
      sourceFile = path.join(work, "source.mp4");
    try {
      execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=blue:s=160x90:r=30:d=2",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=48000:duration=2",
          "-c:v",
          "libx264",
          "-threads",
          "1",
          "-c:a",
          "aac",
          "-pix_fmt",
          "yuv420p",
          sourceFile,
        ],
        { timeout: 10000 },
      );
      const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex"),
        before = sha(await readFile(sourceFile));
      const source = {
        path: sourceFile,
        width: 160,
        height: 90,
        durationUs: 2000000n,
        frameRate: { numerator: 30, denominator: 1 },
        hasAudio: true,
        audioSamples: 96000n,
      };
      const settings = { targetLufs: -23, truePeakDb: -1, loudnessRange: 7 };
      const measure = await new FfmpegExecutor().execute(
        buildLoudnessMeasureArgs(source, settings),
        { timeoutMs: 10000 },
      );
      const edits: VideoEdit[] = [
        { operation: "crop_video", x: 10, y: 10, width: 64, height: 64 },
        { operation: "resize_video", width: 320, height: 180 },
        { operation: "change_speed", numerator: 2, denominator: 1 },
        { operation: "change_speed", numerator: 1, denominator: 2 },
        {
          operation: "normalize_audio",
          ...settings,
          measured: parseLoudnessMeasurement(measure.stderr),
        },
      ];
      for (const [i, edit] of edits.entries())
        await t.test(edit.operation + "-" + i, async () => {
          const output = path.join(work, `out-${i}.mp4`),
            timing = editOutputTiming(source, edit),
            args = buildVideoEditArgs(source, edit, output);
          await new FfmpegExecutor().execute(args, { timeoutMs: 15000 });
          const p = await new FFprobeMediaProbe().inspect({ filePath: output });
          assert.equal(p.width, timing.width);
          assert.equal(p.height, timing.height);
          assert.equal(p.videoCodec, "h264");
          assert.equal(p.audioCodec, "aac");
          assert.ok(
            p.duration !== null &&
              p.duration - timing.durationUs < 18000n &&
              p.duration - timing.durationUs > -18000n,
          );
          const detailed = JSON.parse(
            execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", output], {
              encoding: "utf8",
            }),
          ) as { streams: { codec_type: string; duration: string; nb_frames: string }[] };
          assert.equal(
            Number(detailed.streams.find((s) => s.codec_type === "video")!.nb_frames),
            timing.totalFrames,
          );
          assert.ok(
            Math.abs(
              Number(detailed.streams.find((s) => s.codec_type === "audio")!.duration) -
                Number(timing.durationUs) / 1000000,
            ) < 0.045,
            "Audio must cover the exact edited duration within one video-frame plus codec padding",
          );
          const result = sha(await readFile(output));
          await new FfmpegExecutor().execute(args, { timeoutMs: 15000 });
          assert.equal(sha(await readFile(output)), result);
          if (edit.operation === "normalize_audio") {
            const independent = spawnSync(
              "ffmpeg",
              ["-hide_banner", "-i", output, "-af", "ebur128=peak=true", "-f", "null", "-"],
              { encoding: "utf8" },
            );
            assert.equal(independent.status, 0);
            const lufs = Number(
              [...independent.stderr.matchAll(/I:\s*(-?[0-9.]+) LUFS/g)].at(-1)?.[1],
            );
            assert.ok(Number.isFinite(lufs) && Math.abs(lufs + 23) <= 0.5);
          }
        });
      assert.equal(sha(await readFile(sourceFile)), before);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);

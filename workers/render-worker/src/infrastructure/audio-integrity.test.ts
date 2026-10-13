import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCutRenderArgs, FfmpegExecutor } from "@editagent/media-core";
import { validateOutput } from "./probe-output.js";
import { expectedTimelineAudio } from "./audio-contract.js";
import { timelineFixture } from "./timeline-mapping.test.js";
import type { FixtureInput } from "../application/ports.js";

test("audio expectation comes from used trusted assets; callers cannot omit timeline audio validation", async () => {
  const input = timelineFixture(),
    id = input.props.timeline.sources[0]!.id;
  assert.equal(expectedTimelineAudio(input, [{ sourceId: id, audioPresent: true }]), true);
  assert.equal(expectedTimelineAudio(input, [{ sourceId: "unused", audioPresent: true }]), false);
  assert.equal(expectedTimelineAudio(input, [{ sourceId: id, audioPresent: false }]), false);
  await assert.rejects(validateOutput("/not-read", input), /authoritative audio contract/);
});

test(
  "real MP4 validation rejects truncated, missing and displaced audio before publication",
  { timeout: 60000 },
  async () => {
    const work = await mkdtemp(path.join(tmpdir(), "render-audio-validation-"));
    const ffmpeg = (args: string[]) =>
      execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { timeout: 15000 });
    const input: FixtureInput = {
      schemaVersion: 1,
      renderVersion: "a".repeat(64),
      compositionId: "FixtureV1",
      correlationId: "qa53-audio",
      width: 64,
      height: 64,
      frameRate: { numerator: 25, denominator: 1 },
      durationInFrames: 45,
      props: { title: "test", background: "#000000" },
    };
    try {
      const source = path.join(work, "source.mp4"),
        good = path.join(work, "good.mp4");
      ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=64x64:r=25:d=4",
        "-f",
        "lavfi",
        "-i",
        "sine=r=48000:d=4",
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-bf",
        "3",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        source,
      ]);
      const clip = (a: number, b: number, from: number) => ({
        path: source,
        sourceStartUs: BigInt(a) * 40000n,
        sourceEndUs: BigInt(b) * 40000n,
        fromFrame: from,
        frames: b - a,
        hasAudio: true,
      });
      await new FfmpegExecutor().execute(
        buildCutRenderArgs({
          width: 64,
          height: 64,
          frameRate: input.frameRate,
          totalFrames: 45,
          background: "#000000",
          output: good,
          segments: [
            clip(10, 30, 0),
            { fromFrame: 20, frames: 5, hasAudio: false },
            clip(50, 62, 25),
            clip(10, 15, 37),
            { fromFrame: 42, frames: 3, hasAudio: false },
          ],
        }),
        { timeoutMs: 15000 },
      );
      const validated = await validateOutput(good, input, undefined, true);
      assert.equal(validated.decodedFrames, 45);
      assert.equal(validated.durationUs, "1800000");
      assert.ok(
        BigInt(validated.decodedAudioSamples) >= 86400n &&
          BigInt(validated.decodedAudioSamples) <= 87423n,
      );
      const truncated = path.join(work, "truncated.mp4");
      ffmpeg([
        "-i",
        good,
        "-f",
        "lavfi",
        "-i",
        "sine=r=48000:d=0.6",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-ac",
        "2",
        truncated,
      ]);
      await assert.rejects(validateOutput(truncated, input, undefined, true), /audio duration/);
      const missing = path.join(work, "missing.mp4");
      ffmpeg(["-i", good, "-map", "0:v:0", "-c:v", "copy", "-an", missing]);
      await assert.rejects(validateOutput(missing, input, undefined, true), /audio presence/);
      const displaced = path.join(work, "displaced.mp4");
      ffmpeg([
        "-i",
        good,
        "-itsoffset",
        "0.08",
        "-i",
        good,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c",
        "copy",
        displaced,
      ]);
      await assert.rejects(validateOutput(displaced, input, undefined, true), /audio stream clock/);
      const excess = path.join(work, "excess.mp4");
      ffmpeg([
        "-i",
        good,
        "-f",
        "lavfi",
        "-i",
        "sine=r=48000:d=1.88",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-ac",
        "2",
        excess,
      ]);
      await assert.rejects(validateOutput(excess, input, undefined, true), /audio duration/);
      await assert.rejects(validateOutput(good, input, undefined, false), /audio presence/);
      await validateOutput(missing, input, undefined, false);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCutRenderArgs } from "./ffmpeg-cuts.js";
import { FfmpegExecutor } from "./ffmpeg-executor.js";
import { FFprobeMediaProbe } from "./ffprobe-adapter.js";
const frameUs = (f: number, n: number, d: number) =>
  (BigInt(f) * 1000000n * BigInt(d) + BigInt(Math.floor(n / 2))) / BigInt(n);
test(
  "real cut MP4s preserve independently decoded source-frame boundaries at 25, 30 and 30000/1001",
  { timeout: 60000 },
  async (t) => {
    const work = await mkdtemp(path.join(tmpdir(), "media-cuts-"));
    try {
      const pixels = Buffer.alloc(160 * 90 * 3 * 60);
      for (let frame = 0; frame < 60; frame++)
        for (let p = 0; p < 160 * 90; p++) {
          const at = (frame * 160 * 90 + p) * 3;
          pixels[at] = frame * 3 + 20;
          pixels[at + 1] = 40;
          pixels[at + 2] = 30;
        }
      const raw = path.join(work, "source.rgb");
      await writeFile(raw, pixels);
      for (const [n, d] of [
        [25, 1],
        [30, 1],
        [30000, 1001],
      ])
        await t.test(`${n}/${d} non-integer cuts, gap audio and exact output count`, async () => {
          const source = path.join(work, `source-${n}.mp4`),
            output = path.join(work, `output-${n}.mp4`);
          // Fixture generation and independent verification are test-only process paths.
          execFileSync(
            "ffmpeg",
            [
              "-hide_banner",
              "-loglevel",
              "error",
              "-nostdin",
              "-y",
              "-f",
              "rawvideo",
              "-pix_fmt",
              "rgb24",
              "-s",
              "160x90",
              "-r",
              `${n}/${d}`,
              "-i",
              raw,
              "-f",
              "lavfi",
              "-i",
              "sine=frequency=440:sample_rate=48000",
              "-frames:v",
              "60",
              "-c:v",
              "libx264",
              "-crf",
              "0",
              "-pix_fmt",
              "yuv444p",
              "-c:a",
              "aac",
              "-video_track_timescale",
              String(n),
              "-shortest",
              source,
            ],
            { timeout: 20000 },
          );
          const recipe = {
            // Source cadence is independently inspected before selecting the fast path.
            width: 320,
            height: 180,
            frameRate: { numerator: n!, denominator: d! },
            totalFrames: 49,
            background: "#000000",
            output,
            segments: [
              { fromFrame: 0, frames: 3, hasAudio: false },
              {
                path: source,
                fromFrame: 3,
                frames: 20,
                sourceStartUs: frameUs(10, n!, d!),
                sourceEndUs: frameUs(30, n!, d!),
                hasAudio: true,
              },
              { fromFrame: 23, frames: 2, hasAudio: false },
              {
                path: source,
                fromFrame: 25,
                frames: 20,
                sourceStartUs: frameUs(40, n!, d!),
                sourceEndUs: frameUs(60, n!, d!),
                hasAudio: true,
              },
              { fromFrame: 45, frames: 4, hasAudio: false },
            ],
          };
          const frames: number[] = [];
          assert.equal(
            await new FFprobeMediaProbe().supportsCutRendering({ filePath: source }),
            true,
          );
          await new FfmpegExecutor().execute(buildCutRenderArgs(recipe), {
            timeoutMs: 20000,
            onProgress: (p) => frames.push(p.frame),
          });
          const p = await new FFprobeMediaProbe().inspect({ filePath: output });
          assert.equal(p.videoCodec, "h264");
          assert.equal(p.audioCodec, "aac");
          assert.equal(p.width, 320);
          assert.equal(p.height, 180);
          assert.equal(p.frameRate!.numerator * BigInt(d!), p.frameRate!.denominator * BigInt(n!));
          assert.ok(
            p.duration !== null &&
              p.duration - frameUs(49, n!, d!) < 2000n &&
              p.duration - frameUs(49, n!, d!) > -2000n,
          );
          assert.ok((await stat(output)).size > 0);
          const decoded = execFileSync(
            "ffmpeg",
            [
              "-v",
              "error",
              "-i",
              output,
              "-map",
              "0:v:0",
              "-f",
              "rawvideo",
              "-pix_fmt",
              "rgb24",
              "-",
            ],
            { maxBuffer: 16777216 },
          );
          const stride = 320 * 180 * 3;
          assert.equal(decoded.length, stride * 49);
          const red = (frame: number) => decoded[frame * stride + Math.floor(stride / 2)]!;
          assert.ok(red(2) < 8);
          assert.ok(Math.abs(red(3) - 50) <= 5);
          assert.ok(Math.abs(red(22) - 107) <= 5);
          assert.ok(red(23) < 8);
          assert.ok(red(24) < 8);
          assert.ok(Math.abs(red(25) - 140) <= 5);
          assert.ok(Math.abs(red(44) - 197) <= 5);
          assert.ok(red(45) < 8);
          assert.ok(red(48) < 8);
          const pcm = execFileSync(
            "ffmpeg",
            [
              "-v",
              "error",
              "-i",
              output,
              "-map",
              "0:a:0",
              "-ac",
              "1",
              "-ar",
              "48000",
              "-f",
              "f32le",
              "-",
            ],
            { maxBuffer: 4194304 },
          );
          const rms = (frame: number) => {
            const start = Number((frameUs(frame, n!, d!) * 48000n) / 1000000n) + 300;
            let sum = 0;
            for (let i = start; i < start + 300; i++) {
              const v = pcm.readFloatLE(i * 4);
              sum += v * v;
            }
            return Math.sqrt(sum / 300);
          };
          assert.ok(rms(1) < 0.005);
          assert.ok(rms(6) > 0.03);
          assert.ok(rms(24) < 0.005);
          assert.ok(rms(30) > 0.03);
          assert.ok(rms(47) < 0.005);
          for (const hasAudio of [false, true]) {
            const shortOutput = path.join(work, `short-${n}-${hasAudio}.mp4`);
            await new FfmpegExecutor().execute(
              buildCutRenderArgs({
                ...recipe,
                output: shortOutput,
                segments: [
                  { fromFrame: 0, frames: 3, hasAudio: false },
                  {
                    path: source,
                    fromFrame: 3,
                    frames: 10,
                    sourceStartUs: frameUs(10, n!, d!),
                    sourceEndUs: frameUs(20, n!, d!),
                    hasAudio,
                  },
                  { fromFrame: 13, frames: 2, hasAudio: false },
                  {
                    path: source,
                    fromFrame: 15,
                    frames: 15,
                    sourceStartUs: frameUs(30, n!, d!),
                    sourceEndUs: frameUs(45, n!, d!),
                    hasAudio,
                  },
                  { fromFrame: 30, frames: 19, hasAudio: false },
                ],
              }),
              { timeoutMs: 20000 },
            );
            const short = execFileSync(
              "ffmpeg",
              [
                "-v",
                "error",
                "-i",
                shortOutput,
                "-map",
                "0:v:0",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "-",
              ],
              { maxBuffer: 16777216 },
            );
            assert.equal(
              short.length,
              stride * 49,
              "Short segments and a long tail preserve every frame",
            );
            for (let f = 0; f < 49; f++) {
              const expected =
                f >= 3 && f < 13
                  ? (f - 3 + 10) * 3 + 20
                  : f >= 15 && f < 30
                    ? (f - 15 + 30) * 3 + 20
                    : 0;
              assert.ok(
                Math.abs(short[f * stride + Math.floor(stride / 2)]! - expected) <= 5,
                `Short-segment source boundary ${f}`,
              );
            }
          }
          t.diagnostic(
            JSON.stringify({
              fps: `${n}/${d}`,
              decodedFrames: 49,
              boundaryChecks: 9,
              audioGaps: true,
              bytes: (await stat(output)).size,
              reportedFinalFrame: frames.at(-1),
            }),
          );
        });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);

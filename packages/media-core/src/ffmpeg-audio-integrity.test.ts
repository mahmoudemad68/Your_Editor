import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { buildCutRenderArgs, type CutSegment } from "./ffmpeg-cuts.js";
import { FfmpegExecutor } from "./ffmpeg-executor.js";
import { FFprobeMediaProbe } from "./ffprobe-adapter.js";

const frameUs = (f: number, n: number, d: number) =>
  (BigInt(f) * 1000000n * BigInt(d) + BigInt(Math.floor(n / 2))) / BigInt(n);
const sampleAt = (f: number, n: number, d: number) =>
  Number((BigInt(f) * 48000n * BigInt(d) + BigInt(Math.floor(n / 2))) / BigInt(n));
const markers = [12, 24, 35, 52, 58, 75, 100, 103, 111, 121];
test(
  "QA53 real yuv420p B-frame audio integrity: backward/repeated/overlapping cuts, gaps, short clips and layouts",
  { timeout: 180000 },
  async (t) => {
    const work = await mkdtemp(path.join(tmpdir(), "qa53-audio-"));
    try {
      execFileSync(
        process.execPath,
        [path.resolve(__dirname, "../../../tools/render/audio-cut-fixtures.mjs"), work],
        { timeout: 60000 },
      );
      const fixtures = JSON.parse(
        await readFile(path.join(work, "bframe-fixtures.json"), "utf8"),
      ) as { file: string; n: number; d: number; layout: string; hasAudio: boolean }[];
      for (const [n, d] of [
        [25, 1],
        [30, 1],
        [30000, 1001],
        [24000, 1001],
        [60000, 1001],
      ]) {
        const mono = fixtures.find((s) => s.n === n && s.layout === "mono48")!,
          stereo = fixtures.find((s) => s.n === n && s.layout === "stereo44")!,
          silent = fixtures.find((s) => s.n === n && s.layout === "none")!;
        for (const source of [mono, stereo, silent])
          assert.equal(
            await new FFprobeMediaProbe().supportsCutRendering(
              { filePath: source.file },
              { numerator: n!, denominator: d! },
            ),
            true,
          );
        const clip = (a: number, b: number, from: number, source = mono): CutSegment => ({
          path: source.file,
          sourceStartUs: frameUs(a, n!, d!),
          sourceEndUs: frameUs(b, n!, d!),
          fromFrame: from,
          frames: b - a,
          hasAudio: source.hasAudio,
        });
        const gap = (from: number, frames: number): CutSegment => ({
          fromFrame: from,
          frames,
          hasAudio: false,
        });
        const cases: Record<string, CutSegment[]> = {
          "qa-backward-repeat": [
            clip(10, 30, 0),
            gap(20, 5),
            clip(50, 62, 25),
            clip(10, 15, 37),
            gap(42, 3),
          ],
          "exact-repeat": [clip(12, 17, 0), clip(12, 17, 5)],
          forward: [clip(10, 30, 0), clip(50, 62, 20)],
          "source-overlap": [clip(10, 30, 0), clip(15, 25, 20)],
          "mixed-layout-and-gaps": [
            clip(10, 20, 0),
            clip(20, 30, 10, silent),
            clip(30, 40, 20, stereo),
            gap(30, 5),
          ],
          "one-frame-short": [clip(12, 13, 0), gap(1, 1), clip(58, 60, 2)],
          "no-audio": [clip(12, 13, 0, silent), gap(1, 1), clip(58, 60, 2, silent)],
          "qa53r-56": [
            clip(10, 24, 0),
            gap(14, 2),
            clip(30, 63, 16),
            gap(49, 2),
            clip(100, 105, 51),
          ],
          "qa53r-58-max-segments": [
            ...[10, 50, 12, 100, 30, 58, 10, 100].flatMap((start, i) => [
              gap(i * 7, 2),
              clip(start, start + 5, i * 7 + 2),
            ]),
            gap(56, 2),
          ],
          "one-gap": [clip(10, 24, 0), gap(14, 2), clip(100, 105, 16)],
          "leading-middle-trailing": [
            gap(0, 1),
            clip(10, 24, 1),
            gap(15, 2),
            clip(30, 63, 17),
            gap(50, 1),
            clip(100, 105, 51),
            gap(56, 2),
          ],
          "mixed-short-gaps": [
            clip(12, 13, 0),
            gap(1, 2),
            clip(100, 105, 3, silent),
            gap(8, 1),
            clip(50, 62, 9, stereo),
            gap(21, 2),
          ],
        };
        for (const [name, segments] of Object.entries(cases))
          await t.test(`${n}/${d} ${name}`, async () => {
            const totalFrames = segments.reduce((a, s) => a + s.frames, 0),
              output = path.join(work, `${n}-${name}.mp4`);
            const args = buildCutRenderArgs({
              segments,
              totalFrames,
              width: 64,
              height: 64,
              frameRate: { numerator: n!, denominator: d! },
              background: "#000000",
              output,
            });
            assert.equal(
              args.filter((a) => a === "-i").length,
              segments.filter((s) => s.path).length,
              "independent segment decoders",
            );
            await new FfmpegExecutor().execute(args, { timeoutMs: 30000 });
            const pixels = execFileSync(
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
              { maxBuffer: 4194304, timeout: 30000 },
            );
            assert.equal(pixels.length, totalFrames * 64 * 64 * 3);
            const beeps: number[] = [];
            for (const s of segments) {
              const start = s.path
                ? Number(
                    (s.sourceStartUs! * BigInt(n!) + 500000n * BigInt(d!)) /
                      (1000000n * BigInt(d!)),
                  )
                : 0;
              for (let f = 0; f < s.frames; f++) {
                const sourceFrame = start + f;
                const expected = !s.path
                  ? [0, 0, 0]
                  : markers.includes(sourceFrame)
                    ? [240, 240, 240]
                    : [
                        20 + (sourceFrame % 8) * 28,
                        20 + (Math.floor(sourceFrame / 8) % 8) * 28,
                        40 + Math.floor(sourceFrame / 64) * 140,
                      ];
                for (let c = 0; c < 3; c++)
                  assert.ok(
                    Math.abs(
                      pixels[((s.fromFrame + f) * 64 * 64 + 32 * 64 + 32) * 3 + c]! - expected[c]!,
                    ) <= 8,
                    `frame ${s.fromFrame + f}`,
                  );
                if (s.hasAudio && markers.includes(sourceFrame))
                  beeps.push(sampleAt(s.fromFrame + f, n!, d!) + 240);
              }
            }
            const streams = await new FFprobeMediaProbe().inspectStreamTiming({ filePath: output });
            const audio = streams.find((s) => s.kind === "audio");
            if (!segments.some((s) => s.hasAudio)) {
              assert.equal(audio, undefined);
              return;
            }
            assert.equal(audio?.sampleRate, 48000);
            assert.equal(audio?.channels, 2);
            const samples = sampleAt(totalFrames, n!, d!);
            assert.equal(
              audio!.durationTicks!,
              BigInt(samples),
              `audio samples ${audio!.durationTicks} expected ${samples}`,
            );
            if (n === 30000 && name === "one-frame-short") {
              for (let attempt = 0; attempt < 20; attempt++) {
                await new FfmpegExecutor().execute(args, { timeoutMs: 30000 });
                const repeated = (
                  await new FFprobeMediaProbe().inspectStreamTiming({ filePath: output })
                ).find((s) => s.kind === "audio")!;
                assert.equal(
                  repeated.durationTicks,
                  BigInt(samples),
                  `short-input stability ${attempt}`,
                );
              }
            }
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
              { maxBuffer: 4194304, timeout: 30000 },
            );
            assert.ok(pcm.length / 4 >= samples && pcm.length / 4 <= samples + 1023);
            const rms = (a: number, b: number) => {
              let sum = 0;
              for (let i = a; i < b; i++) {
                const x = pcm.readFloatLE(i * 4);
                sum += x * x;
              }
              return Math.sqrt(sum / (b - a));
            };
            for (const start of beeps) {
              assert.ok(rms(start + 96, start + 576) > 0.03, "expected audible beep");
              if (start > 480)
                assert.ok(
                  rms(start - 480, start - 240) < 0.015,
                  "beep onset must not lead by 5–10 ms",
                );
            }
            for (const s of segments.filter((s) => !s.hasAudio)) {
              const start = sampleAt(s.fromFrame, n!, d!),
                end = sampleAt(s.fromFrame + s.frames, n!, d!),
                guard = Math.min(480, Math.floor((end - start) / 4)),
                a = start + guard,
                b = end - guard;
              assert.ok(rms(a, b) < 0.005, "explicit gap/no-audio silence");
            }
          });
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);

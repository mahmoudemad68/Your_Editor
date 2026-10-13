import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FFprobeMediaProbe } from "./ffprobe-adapter.js";

test(
  "CFR evidence survives bounded B-frame reorder windows and interleaved audio",
  { timeout: 90000 },
  async (t) => {
    const work = await mkdtemp(path.join(tmpdir(), "cfr-reorder-"));
    try {
      for (const [n, d] of [
        [25, 1],
        [30, 1],
        [30000, 1001],
      ]) {
        for (const [gop, bframes] of [
          [12, 0],
          [12, 2],
          [48, 3],
          [90, 8],
        ]) {
          await t.test(`${n}/${d} GOP ${gop} B ${bframes}`, async () => {
            const file = path.join(work, `${n}-${gop}-${bframes}.mp4`);
            execFileSync(
              "ffmpeg",
              [
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                `testsrc2=s=64x64:r=${n}/${d}:d=6`,
                "-f",
                "lavfi",
                "-i",
                "sine=r=44100:d=6",
                "-c:v",
                "libx264",
                "-threads",
                "1",
                "-pix_fmt",
                "yuv420p",
                "-x264-params",
                `keyint=${gop}:bframes=${bframes}:b-adapt=0:scenecut=0`,
                "-c:a",
                "aac",
                "-ac",
                "2",
                "-video_track_timescale",
                String(n),
                file,
              ],
              { timeout: 20000 },
            );
            const probe = new FFprobeMediaProbe({ timeoutMs: 10000, maxOutputBytes: 1048576 });
            assert.equal(
              await probe.supportsCutRendering(
                { filePath: file },
                { numerator: n!, denominator: d! },
              ),
              true,
            );
            assert.equal(
              await probe.supportsCutRendering(
                { filePath: file },
                { numerator: n === 25 ? 30 : 25, denominator: 1 },
              ),
              false,
            );
          });
        }
      }
      const media = path.resolve(__dirname, "../fixtures/media");
      for (const mode of ["hdr", "vp9"]) {
        const file = path.join(work, `${mode}.mp4`);
        execFileSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=64x64:r=30:d=1",
            "-c:v",
            mode === "vp9" ? "libvpx-vp9" : "libx264",
            "-threads",
            "1",
            ...(mode === "hdr"
              ? [
                  "-x264-params",
                  "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc",
                  "-color_primaries",
                  "bt2020",
                  "-color_trc",
                  "smpte2084",
                  "-colorspace",
                  "bt2020nc",
                ]
              : []),
            file,
          ],
          { timeout: 20000 },
        );
        const actual = JSON.parse(
          execFileSync(
            "ffprobe",
            [
              "-v",
              "error",
              "-show_entries",
              "stream=codec_name,color_transfer",
              "-of",
              "json",
              file,
            ],
            { encoding: "utf8", timeout: 10000 },
          ),
        );
        if (mode === "hdr") assert.equal(actual.streams[0].color_transfer, "smpte2084");
        else assert.equal(actual.streams[0].codec_name, "vp9");
        assert.equal(
          await new FFprobeMediaProbe().supportsCutRendering({ filePath: file }),
          false,
          mode,
        );
      }
      for (const name of ["vfr.mp4", "rotated.mov", "audio.wav", "image.png"])
        assert.equal(
          await new FFprobeMediaProbe().supportsCutRendering({ filePath: path.join(media, name) }),
          false,
          name,
        );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);

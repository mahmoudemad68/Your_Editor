import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { frameColor } from "./editing-fixtures.mjs";
const probe = (file) =>
  JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", file], {
      encoding: "utf8",
    }),
  );
const decode = (file) =>
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      file,
      "-map",
      "0:v:0",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-threads",
      "1",
      "pipe:1",
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  );
function pcm(file) {
  const b = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      file,
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-f",
      "f32le",
      "pipe:1",
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  return Array.from({ length: b.length / 4 }, (_, i) => b.readFloatLE(i * 4));
}
const rms = (a, start, end) =>
  Math.sqrt(a.slice(start, end).reduce((s, v) => s + v * v, 0) / (end - start));
export function verifyEditingArtifacts(directory, report) {
  for (const a of report.artifacts) {
    const file = directory + "/" + a.label + ".mp4",
      p = probe(file),
      v = p.streams.find((s) => s.codec_type === "video"),
      audio = p.streams.find((s) => s.codec_type === "audio");
    assert.equal(
      createHash("sha256").update(readFileSync(file)).digest("hex"),
      a.sha256,
      "Stored outputs and a derived input reused by another tool remain content-identical",
    );
    assert.equal(v.codec_name, "h264");
    const hasAudio = a.metadata?.audioPresent ?? a.hasAudio ?? true;
    assert.equal(audio?.codec_name, hasAudio ? "aac" : undefined);
    const raw = decode(file),
      frames = raw.length / (v.width * v.height * 3);
    assert.equal(Number.isInteger(frames), true);
    if (a.metadata) {
      assert.equal(v.width, a.metadata.width);
      assert.equal(v.height, a.metadata.height);
      assert.ok(
        Math.abs(Number(p.format.duration) - Number(a.metadata.durationUs) / 1000000) < 0.018,
      );
    } else {
      assert.equal(v.avg_frame_rate, a.frameRate);
      assert.equal(frames, a.frames);
      assert.equal(v.width, 64);
      assert.equal(v.height, 64);
    }
    if (a.label === "tool-change-speed") {
      assert.equal(frames, 30);
      assert.ok(Math.abs(Number(p.format.duration) - 1) < 0.018);
      assert.ok(rms(pcm(file), 5000, 40000) > 0.03);
    }
    if (a.label === "tool-concat-clips") {
      assert.ok(raw[0] > 245);
      assert.ok(raw[30 * 64 * 64 * 3] < 5);
    }
    if (a.label === "tool-normalize-audio") {
      const measurement = spawnSync(
        "ffmpeg",
        ["-hide_banner", "-nostdin", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"],
        { encoding: "utf8", maxBuffer: 1048576 },
      );
      assert.equal(measurement.status, 0);
      const lufs = Number([...measurement.stderr.matchAll(/I:\s*(-?[0-9.]+) LUFS/g)].at(-1)?.[1]);
      assert.ok(
        Number.isFinite(lufs) && Math.abs(lufs + 23) <= 0.5,
        `Independent normalized loudness ${lufs}`,
      );
      a.measuredLufs = lufs;
    }
    a.independentProbe = {
      frames,
      width: v.width,
      height: v.height,
      fps: v.avg_frame_rate,
      duration: p.format.duration,
      codec: v.codec_name,
      audio: audio?.codec_name ?? null,
    };
    if (a.label === "strategy-rounding-fallback") {
      for (let f = 0; f < 49; f++) {
        const expected =
          f >= 3 && f < 14
            ? frameColor(f - 3 + 10)
            : f >= 15 && f < 30
              ? frameColor(f - 15 + 30)
              : [0, 0, 0];
        for (let c = 0; c < 3; c++)
          assert.ok(
            Math.abs(raw[(f * 64 * 64 + 32 * 64 + 32) * 3 + c] - expected[c]) <= 8,
            `Canonical rounding fallback frame ${f}`,
          );
      }
    }
  }
  for (const n of [25, 30, 30000]) {
    for (const variant of n === 30
      ? ["single-source", "mixed-audio", "no-audio"]
      : ["single-source", "mixed-audio"]) {
      const pair = report.parity.filter((a) => a.label.startsWith(`strategy-${n}-${variant}-`));
      assert.equal(pair.length, 2);
      const pixels = pair.map((a) => decode(directory + "/" + a.label + ".mp4")),
        hashes = [];
      for (const image of pixels) {
        assert.equal(image.length, 49 * 64 * 64 * 3);
        for (let frame = 0; frame < 49; frame++) {
          const expected =
            frame >= 3 && frame < 13
              ? frameColor(frame - 3 + 9)
              : frame >= 15 && frame < 30
                ? frameColor(frame - 15 + 30)
                : [0, 0, 0];
          for (let c = 0; c < 3; c++) {
            const actual = image[(frame * 64 * 64 + 32 * 64 + 32) * 3 + c];
            assert.ok(
              Math.abs(actual - expected[c]) <= 8,
              `Independent native source boundary ${n}, frame ${frame}, channel ${c}: ${actual} vs ${expected[c]}`,
            );
          }
        }
        hashes.push(createHash("sha256").update(image).digest("hex"));
      }
      const meanError =
        pixels[0].reduce((sum, v, i) => sum + Math.abs(v - pixels[1][i]), 0) / pixels[0].length;
      assert.ok(
        meanError <= 4,
        `Decoded FFmpeg/Remotion mean channel error ${meanError} exceeds codec/resampling allowance`,
      );
      const audio =
          variant === "no-audio" ? [] : pair.map((a) => pcm(directory + "/" + a.label + ".mp4")),
        fps = n === 30000 ? 30000 / 1001 : n;
      for (const a of audio) {
        const sample = (f) => Math.round((f * 48000) / fps);
        assert.ok(rms(a, sample(5), sample(11)) > 0.03);
        assert.ok(
          variant === "mixed-audio"
            ? rms(a, sample(17), sample(26)) < 0.005
            : rms(a, sample(17), sample(26)) > 0.03,
        );
        assert.ok(rms(a, sample(33), sample(45)) < 0.005);
      }
      pair.forEach((a) => {
        a.decodedFrameSha256 = hashes[pair.indexOf(a)];
        a.decodedMeanChannelError = meanError;
        a.audioTimingVerified = true;
      });
    }
  }
  return { decodedFrameParity: true, independentBoundaries: true, audioSynchronization: true };
}

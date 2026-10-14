/** Independent sample-authored QA53R-2 fixtures; never derive expectations from edited output. */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { sampleAt, audioFrameColor } from "./audio-cut-fixtures.mjs";
export function prepareSpatialFixtures(directory, select = () => true) {
  mkdirSync(directory, { recursive: true });
  const plans = [];
  for (const [n, d] of [
    [25, 1],
    [30, 1],
    [30000, 1001],
    [24000, 1001],
    [60000, 1001],
  ]) {
    for (const relation of ["shorter", "equal", "longer"]) {
      const frames = 60,
        videoSamples = sampleAt(frames, n, d);
      plans.push({
        n,
        d,
        frames,
        relation,
        samples:
          videoSamples + (relation === "shorter" ? -24000 : relation === "longer" ? 24000 : 0),
      });
    }
  }
  plans.push({ n: 30000, d: 1001, frames: 179, relation: "qa2997-l1", samples: 310656 });
  return plans.filter(select).map((p) => {
    const label = `spatial-${p.n}-${p.relation}`,
      file = path.join(directory, label + ".mp4");
    const rgb = Buffer.alloc(p.frames * 64 * 64 * 3);
    for (let f = 0; f < p.frames; f++)
      for (let i = 0; i < 64 * 64; i++)
        for (let c = 0; c < 3; c++) rgb[(f * 64 * 64 + i) * 3 + c] = audioFrameColor(f)[c];
    const markers =
      p.relation === "qa2997-l1" ? [0.105, 6.005, 6.335] : [0.105, (p.samples - 4800) / 48000];
    const pcm = Buffer.alloc(p.samples * 2);
    for (const time of markers) {
      const start = Math.round(time * 48000);
      for (let i = 0; i < 960 && start + i < p.samples; i++)
        pcm.writeInt16LE(
          Math.round(
            Math.sin((2 * Math.PI * 1000 * i) / 48000) *
              0.6 *
              Math.min(1, i / 48, (960 - i) / 48) *
              32767,
          ),
          (start + i) * 2,
        );
    }
    const raw = path.join(directory, label + ".rgb"),
      audio = path.join(directory, label + ".pcm");
    writeFileSync(raw, rgb);
    writeFileSync(audio, pcm);
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        "64x64",
        "-r",
        `${p.n}/${p.d}`,
        "-i",
        raw,
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "1",
        "-i",
        audio,
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-threads",
        "1",
        "-bf",
        "3",
        "-pix_fmt",
        "yuv420p",
        "-video_track_timescale",
        String(p.n),
        "-c:a",
        "aac",
        "-movie_timescale",
        "48000",
        file,
      ],
      { timeout: 30000, maxBuffer: 1048576 },
    );
    const durationUs = String(
      Math.max(
        Math.round((p.samples * 1000000) / 48000),
        Math.round((p.frames * 1000000 * p.d) / p.n),
      ),
    );
    return {
      ...p,
      markers,
      file,
      layout: label,
      hasAudio: true,
      sampleRate: 48000,
      channels: 1,
      assetDurationUs: durationUs,
      sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
    };
  });
}
export function verifySpatialOutput(file, fixture, operation) {
  const streams = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file], {
      encoding: "utf8",
      timeout: 10000,
    }),
  ).streams;
  const video = streams.find((s) => s.codec_type === "video"),
    audio = streams.find((s) => s.codec_type === "audio");
  assert.equal(Number(video.nb_frames), fixture.frames);
  assert.equal(video.avg_frame_rate, `${fixture.n}/${fixture.d}`);
  assert.equal(audio.duration_ts, fixture.samples);
  assert.equal(audio.start_pts, 0);
  assert.equal(audio.time_base, "1/48000");
  const dimensions = operation === "crop_video" ? 32 : 128;
  assert.equal(video.width, dimensions);
  assert.equal(video.height, dimensions);
  const pixels = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-threads",
      "1",
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
      "-",
    ],
    { timeout: 30000, maxBuffer: 20000000 },
  );
  assert.equal(pixels.length, fixture.frames * dimensions * dimensions * 3);
  for (let f = 0; f < fixture.frames; f++)
    for (let c = 0; c < 3; c++)
      assert.ok(
        Math.abs(
          pixels[
            (f * dimensions * dimensions +
              Math.floor(dimensions / 2) * dimensions +
              Math.floor(dimensions / 2)) *
              3 +
              c
          ] - audioFrameColor(f)[c],
        ) <= 8,
        `Original video frame ${f}`,
      );
  const pcm = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-threads",
      "1",
      "-i",
      file,
      "-map",
      "0:a:0",
      "-ar",
      "48000",
      "-ac",
      "1",
      "-f",
      "f32le",
      "-",
    ],
    { timeout: 30000, maxBuffer: 5000000 },
  );
  const decodedSamples = pcm.length / 4;
  assert.ok(decodedSamples >= fixture.samples && decodedSamples <= fixture.samples + 1023);
  const measured = [];
  for (const time of fixture.markers) {
    const start = Math.round(time * 48000);
    let energy = 0,
      onset = -1;
    for (let i = start - 48; i < start + 960; i++) {
      const v = pcm.readFloatLE(i * 4);
      if (Math.abs(v) > 0.03 && onset < 0) onset = i;
      if (i >= start) energy += v * v;
    }
    assert.ok(Math.sqrt(energy / 960) > 0.15, "Genuine audio marker preserved");
    assert.ok(
      onset >= start - 48 && onset <= start + 48,
      "Audio event retains its source timestamp within 1ms",
    );
    measured.push({ expectedSample: start, actualSample: onset });
  }
  // Reject same-length replacement by silence, rather than relying on stream duration alone.
  return {
    frames: fixture.frames,
    logicalSamples: audio.duration_ts,
    decodedSamples,
    aacPaddingSamples: decodedSamples - fixture.samples,
    markers: measured,
  };
}

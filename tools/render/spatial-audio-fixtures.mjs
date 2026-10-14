/** Independent sample-authored QA53R-2 fixtures; never derive expectations from edited output. */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { sampleAt, audioFrameColor } from "./audio-cut-fixtures.mjs";
export function prepareSpatialFixtures(directory, select = () => true, shortSources = false) {
  mkdirSync(directory, { recursive: true });
  const plans = [];
  for (const [n, d] of [
    [25, 1],
    [30, 1],
    [30000, 1001],
    [24000, 1001],
    [60000, 1001],
  ]) {
    if (shortSources) {
      for (const frames of [1, 2, 3])
        for (const relation of ["none", "shorter", "equal", "longer"]) {
          const videoSamples = sampleAt(frames, n, d);
          plans.push({
            n,
            d,
            frames,
            relation,
            shortSource: true,
            samples:
              relation === "none"
                ? 0
                : relation === "shorter"
                  ? Math.floor(videoSamples / 2)
                  : relation === "longer"
                    ? 19200
                    : videoSamples,
          });
        }
      continue;
    }
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
  if (!shortSources)
    plans.push({ n: 30000, d: 1001, frames: 179, relation: "qa2997-l1", samples: 310656 });
  return plans.filter(select).map((p) => {
    const label = `spatial-${p.shortSource ? "short-" : ""}${p.n}-${p.shortSource ? p.frames + "f-" : ""}${p.relation}`,
      file = path.join(directory, label + ".mp4");
    const rgb = Buffer.alloc(p.frames * 64 * 64 * 3);
    for (let f = 0; f < p.frames; f++)
      for (let i = 0; i < 64 * 64; i++)
        for (let c = 0; c < 3; c++) rgb[(f * 64 * 64 + i) * 3 + c] = audioFrameColor(f)[c];
    const markerLength = p.shortSource ? Math.min(960, Math.floor(p.samples / 3)) : 960;
    const markers = p.shortSource
      ? p.samples
        ? [Math.floor(p.samples / 4) / 48000, ...(p.relation === "longer" ? [0.305] : [])]
        : []
      : p.relation === "qa2997-l1"
        ? [0.105, 6.005, 6.335]
        : [0.105, (p.samples - 4800) / 48000];
    const pcm = Buffer.alloc(p.samples * 2);
    for (const time of markers) {
      const start = Math.round(time * 48000);
      for (let i = 0; i < markerLength && start + i < p.samples; i++)
        pcm.writeInt16LE(
          Math.round(
            Math.sin((2 * Math.PI * 1000 * i) / 48000) *
              0.6 *
              Math.min(1, i / 48, (markerLength - i) / 48) *
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
        ...(p.relation === "none" ? [] : ["-f", "s16le", "-ar", "48000", "-ac", "1", "-i", audio]),
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
        ...(p.relation === "none" ? ["-an"] : ["-c:a", "aac"]),
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
      markerLength,
      file,
      layout: label,
      hasAudio: p.relation !== "none",
      sampleRate: 48000,
      channels: 1,
      assetDurationUs: durationUs,
      sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
    };
  });
}
export function prepareUnverifiableSpatialFixture(directory) {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "spatial-unverifiable-vfr.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=64x64:r=30:d=0.1",
      "-vf",
      "setpts=if(eq(N\\,2)\\,3\\,N)/(30*TB)",
      "-fps_mode",
      "vfr",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-bf",
      "3",
      "-pix_fmt",
      "yuv420p",
      "-video_track_timescale",
      "30000",
      "-movie_timescale",
      "48000",
      file,
    ],
    { timeout: 30000 },
  );
  return {
    file,
    n: 30,
    d: 1,
    frames: 3,
    hasAudio: false,
    sampleRate: 48000,
    channels: 1,
    layout: "spatial-unverifiable-vfr",
    rejectSpatial: true,
    assetDurationUs: "133333",
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
  };
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
  if (fixture.hasAudio) {
    assert.equal(audio.duration_ts, fixture.samples);
    assert.equal(audio.start_pts, 0);
    assert.equal(audio.time_base, "1/48000");
  } else assert.equal(audio, undefined);
  const width = operation === "crop_video" ? 32 : fixture.shortSource ? 160 : 128;
  const height = operation === "crop_video" ? 32 : fixture.shortSource ? 120 : 128;
  assert.equal(video.width, width);
  assert.equal(video.height, height);
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
  assert.equal(pixels.length, fixture.frames * width * height * 3);
  for (let f = 0; f < fixture.frames; f++)
    for (let c = 0; c < 3; c++)
      assert.ok(
        Math.abs(
          pixels[
            (f * width * height + Math.floor(height / 2) * width + Math.floor(width / 2)) * 3 + c
          ] - audioFrameColor(f)[c],
        ) <= 8,
        `Original video frame ${f}`,
      );
  if (!fixture.hasAudio)
    return {
      frames: fixture.frames,
      logicalSamples: 0,
      decodedSamples: 0,
      aacPaddingSamples: 0,
      markers: [],
    };
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
    const markerLength = fixture.markerLength ?? 960;
    for (let i = Math.max(0, start - 48); i < start + markerLength; i++) {
      const v = pcm.readFloatLE(i * 4);
      if (Math.abs(v) > 0.03 && onset < 0) onset = i;
      if (i >= start) energy += v * v;
    }
    assert.ok(
      Math.sqrt(energy / markerLength) > (fixture.shortSource ? 0.08 : 0.15),
      "Genuine audio marker preserved",
    );
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

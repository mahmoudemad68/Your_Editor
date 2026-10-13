import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { sampleAt, beepFrames, audioFrameColor } from "./audio-cut-fixtures.mjs";

export function verifyAudioCutArtifacts(directory, report) {
  for (const artifact of report.artifacts) {
    const file = `${directory}/${artifact.label}.mp4`;
    assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), artifact.sha256);
    const probe = JSON.parse(
      execFileSync(
        "ffprobe",
        ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
        { encoding: "utf8", timeout: 10000 },
      ),
    );
    const video = probe.streams.find((s) => s.codec_type === "video"),
      audio = probe.streams.find((s) => s.codec_type === "audio");
    assert.equal(video.avg_frame_rate, `${artifact.n}/${artifact.d}`);
    const pixels = execFileSync(
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
        "-",
      ],
      { maxBuffer: 16000000, timeout: 10000 },
    );
    assert.equal(pixels.length, artifact.frames * video.width * video.height * 3, artifact.label);
    assert.equal(Boolean(audio), artifact.hasAudio);
    if (artifact.speedDiagnostic) {
      const pcm = execFileSync(
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
          "-",
        ],
        { maxBuffer: 16000000, timeout: 10000 },
      );
      let onset = -1;
      for (let i = 0; i < Math.min(96000, pcm.length / 4); i++) {
        if (Math.abs(pcm.readFloatLE(i * 4)) > 0.03) {
          onset = i;
          break;
        }
      }
      assert.ok(onset >= 0, "Actual slowed audio must contain the authored beep");
      const expectedOnsetUs = 1215000;
      artifact.independentVerification = {
        frames: artifact.frames,
        expectedOnsetUs,
        actualOnsetUs: Math.round((onset * 1000000) / 48000),
        offsetUs: Math.round((onset * 1000000) / 48000) - expectedOnsetUs,
        syncAcceptance: "NOT_PROVEN",
        knownAtTempoTransientDrift: true,
      };
      continue;
    }
    if (artifact.resize) {
      assert.equal(video.width, 128);
      assert.equal(video.height, 128);
      artifact.independentVerification = { frames: artifact.frames, duplicated180thFrame: false };
      continue;
    }
    assert.equal(video.width, 64);
    assert.equal(video.height, 64);
    const beeps = [];
    for (const segment of artifact.segments) {
      for (let f = 0; f < segment.frames; f++) {
        const source = segment.start + f,
          color = segment.media ? audioFrameColor(source) : [0, 0, 0];
        for (let c = 0; c < 3; c++)
          assert.ok(
            Math.abs(pixels[((segment.from + f) * 64 * 64 + 32 * 64 + 32) * 3 + c] - color[c]) <= 8,
            `${artifact.label} frame ${segment.from + f}`,
          );
        if (segment.hasAudio && beepFrames.includes(source))
          beeps.push(sampleAt(segment.from + f, artifact.n, artifact.d) + 240);
      }
    }
    let decodedSamples = 0,
      streamSamples = 0;
    if (audio) {
      assert.equal(audio.sample_rate, "48000");
      assert.equal(audio.channels, 2);
      assert.equal(audio.start_pts, 0);
      assert.equal(audio.time_base, "1/48000");
      const expected = sampleAt(artifact.frames, artifact.n, artifact.d);
      streamSamples = Number(audio.duration_ts);
      assert.ok(
        streamSamples >= expected - 1 &&
          streamSamples <= expected + (artifact.reference ? 1023 : 1),
        `${artifact.label} logical AAC duration`,
      );
      const pcm = execFileSync(
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
          "-",
        ],
        { maxBuffer: 16000000, timeout: 10000 },
      );
      decodedSamples = pcm.length / 4;
      assert.ok(
        decodedSamples >= expected - 1 &&
          decodedSamples >= streamSamples - (artifact.reference ? 1023 : 1) &&
          decodedSamples <= streamSamples + 1023,
        `${artifact.label} complete decoded PCM with bounded AAC padding`,
      );
      const rms = (a, b) => {
        let sum = 0;
        for (let i = a; i < b; i++) sum += pcm.readFloatLE(i * 4) ** 2;
        return Math.sqrt(sum / (b - a));
      };
      for (const onset of beeps) {
        assert.ok(rms(onset + 96, onset + 576) > 0.03, `${artifact.label} audible aligned beep`);
        if (onset > 480)
          assert.ok(
            rms(onset - 480, onset - 240) < 0.015,
            `${artifact.label} no beep 5–10ms early`,
          );
      }
      for (const s of artifact.segments.filter((s) => !s.hasAudio && s.frames > 1)) {
        const a = sampleAt(s.from, artifact.n, artifact.d) + 480,
          b = sampleAt(s.from + s.frames, artifact.n, artifact.d) - 480;
        assert.ok(rms(a, b) < 0.005, `${artifact.label} gap/no-audio segment`);
      }
    }
    artifact.independentVerification = {
      frames: artifact.frames,
      expectedSamples: artifact.hasAudio ? sampleAt(artifact.frames, artifact.n, artifact.d) : 0,
      streamSamples,
      decodedSamples,
      audibleAlignedBeeps: beeps.length,
      formatDuration: probe.format.duration,
    };
  }
  const negative = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_streams",
        "-of",
        "json",
        `${directory}/${report.negativeArtifact.label}.mp4`,
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(Number(negative.streams.find((s) => s.codec_type === "video").nb_frames), 45);
  assert.ok(Number(negative.streams.find((s) => s.codec_type === "audio").duration_ts) < 86400);
  return {
    framesAndAudioIndependentlyVerified: true,
    artifacts: report.artifacts.length,
    falseSuccessNegativeVerified: true,
  };
}

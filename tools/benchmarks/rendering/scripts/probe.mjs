import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { loadSpec } from "./load-spec.mjs";

export function probeFile(file) {
  const spec = loadSpec();
  const probed = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
    { encoding: "utf8" },
  );
  if (probed.status !== 0) {
    return { ok: false, error: probed.stderr };
  }
  const parsed = JSON.parse(probed.stdout);
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(parsed.format?.duration ?? Number.NaN);
  const size = statSync(file).size;
  const problems = [];
  if (video === undefined) {
    problems.push("missing video");
  } else {
    if (video.codec_name !== spec.videoCodec) {
      problems.push(`video codec ${video.codec_name}`);
    }
    if (Number(video.width) !== spec.width || Number(video.height) !== spec.height) {
      problems.push(`resolution ${video.width}x${video.height}`);
    }
    if (video.pix_fmt !== spec.pixelFormat && video.pix_fmt !== "yuvj420p") {
      problems.push(`pixel format ${video.pix_fmt}`);
    }
    const rate = String(video.avg_frame_rate ?? "");
    if (rate !== `${spec.fps}/1` && rate !== String(spec.fps)) {
      problems.push(`frame rate ${rate}`);
    }
  }
  if (audio === undefined) {
    problems.push("missing audio");
  } else if (audio.codec_name !== spec.audioCodec) {
    problems.push(`audio codec ${audio.codec_name}`);
  }
  if (!Number.isFinite(duration) || Math.abs(duration - spec.durationSeconds) > 0.1) {
    problems.push(`duration ${duration}`);
  }
  if (size <= 0) {
    problems.push("empty file");
  }
  return {
    ok: problems.length === 0,
    problems,
    durationSeconds: duration,
    width: video === undefined ? null : Number(video.width),
    height: video === undefined ? null : Number(video.height),
    frameRate: video?.avg_frame_rate ?? null,
    videoCodec: video?.codec_name ?? null,
    pixelFormat: video?.pix_fmt ?? null,
    audioCodec: audio?.codec_name ?? null,
    sizeBytes: size,
    bitrateBps: Number(parsed.format?.bit_rate ?? 0),
  };
}

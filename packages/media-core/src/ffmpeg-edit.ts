import {
  boundedNumber,
  localMediaPath,
  validateFilterGraph,
  loudnessFilter,
  type LoudnessSettings,
} from "./ffmpeg-builder.js";
export interface EditSource {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly durationUs: bigint;
  readonly frameRate: { numerator: number; denominator: number };
  readonly hasAudio: boolean;
}
export type VideoEdit =
  | {
      readonly operation: "crop_video";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    }
  | { readonly operation: "resize_video"; readonly width: number; readonly height: number }
  | { readonly operation: "change_speed"; readonly numerator: number; readonly denominator: number }
  | ({ readonly operation: "normalize_audio" } & LoudnessSettings);
export function editOutputTiming(source: EditSource, edit: VideoEdit) {
  const n = boundedNumber(source.frameRate.numerator, 1, 60000, true),
    d = boundedNumber(source.frameRate.denominator, 1, 1001, true);
  if (n / d < 1 || n / d > 60 || source.durationUs <= 0n || source.durationUs > 1800000000n)
    throw new Error("Unsupported source timing.");
  let duration = source.durationUs,
    width = source.width,
    height = source.height;
  if (edit.operation === "crop_video" || edit.operation === "resize_video") {
    width = boundedNumber(edit.width, 2, 4096, true);
    height = boundedNumber(edit.height, 2, 4096, true);
    if (edit.operation === "crop_video") {
      boundedNumber(edit.x, 0, source.width, true);
      boundedNumber(edit.y, 0, source.height, true);
      if (
        edit.x % 2 ||
        edit.y % 2 ||
        edit.x + width > source.width ||
        edit.y + height > source.height
      )
        throw new Error("Crop is outside source pixels.");
    }
  }
  if (edit.operation === "change_speed") {
    const a = boundedNumber(edit.numerator, 1, 16, true),
      b = boundedNumber(edit.denominator, 1, 16, true);
    if (a / b < 0.25 || a / b > 4) throw new Error("Unsupported speed ratio.");
    duration = (duration * BigInt(b) + BigInt(Math.floor(a / 2))) / BigInt(a);
  }
  if (edit.operation === "normalize_audio" && !source.hasAudio)
    throw new Error("Normalization requires audio.");
  boundedNumber(width, 2, 4096, true);
  boundedNumber(height, 2, 4096, true);
  if (
    width % 2 ||
    height % 2 ||
    width * height > 8294400 ||
    duration <= 0n ||
    duration > 1800000000n
  )
    throw new Error("Unsupported edit output.");
  const totalFrames = Number(
    ((2n * duration - 1n) * BigInt(n) + 2000000n * BigInt(d) - 1n) / (2000000n * BigInt(d)),
  );
  boundedNumber(totalFrames, 1, 108000, true);
  const durationUs =
    (BigInt(totalFrames) * 1000000n * BigInt(d) + BigInt(Math.floor(n / 2))) / BigInt(n);
  return { width, height, frameRate: { numerator: n, denominator: d }, totalFrames, durationUs };
}
function audioTempo(n: number, d: number): string[] {
  let ratio = n / d;
  const filters: string[] = [];
  while (ratio > 2) {
    filters.push("atempo=2");
    ratio /= 2;
  }
  while (ratio < 0.5) {
    filters.push("atempo=0.5");
    ratio *= 2;
  }
  filters.push(`atempo=${ratio}`);
  return filters;
}
export function buildVideoEditArgs(
  source: EditSource,
  edit: VideoEdit,
  output: string,
): readonly string[] {
  const t = editOutputTiming(source, edit),
    rate = `${t.frameRate.numerator}/${t.frameRate.denominator}`;
  const video: string[] = ["setpts=PTS-STARTPTS"];
  if (edit.operation === "crop_video")
    video.push(`crop=${edit.width}:${edit.height}:${edit.x}:${edit.y}`);
  if (edit.operation === "resize_video")
    video.push(
      `scale=${edit.width}:${edit.height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
      `pad=${edit.width}:${edit.height}:(ow-iw)/2:(oh-ih)/2`,
    );
  if (edit.operation === "change_speed")
    video.push(`setpts=PTS*${edit.denominator}/${edit.numerator}`);
  video.push(
    `fps=fps=${rate}:start_time=0:round=near`,
    "setsar=1",
    `tpad=stop_mode=clone:stop_duration=${Number(t.durationUs) / 1000000}`,
    `trim=end_frame=${t.totalFrames}`,
    `settb=expr=${t.frameRate.denominator}/${t.frameRate.numerator}`,
    "setpts=N",
  );
  const args = [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-loglevel",
    "info",
    "-threads",
    "2",
    "-filter_threads",
    "1",
    "-filter_complex_threads",
    "1",
    "-protocol_whitelist",
    "file",
    "-format_whitelist",
    "mov,matroska",
    "-max_alloc",
    "67108864",
    "-probesize",
    "5242880",
    "-analyzeduration",
    "5000000",
    "-i",
    localMediaPath(source.path),
    "-progress",
    "pipe:3",
    "-nostats",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-sn",
    "-dn",
    "-map",
    "0:v:0",
    "-vf",
    video.join(","),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-threads",
    "2",
    "-r",
    rate,
    "-fps_mode",
    "cfr",
    "-frames:v",
    String(t.totalFrames),
    "-video_track_timescale",
    String(t.frameRate.numerator),
  ];
  validateFilterGraph(video.join(","));
  if (source.hasAudio) {
    const audio = ["aresample=async=1:first_pts=0", "asetpts=PTS-STARTPTS"];
    if (edit.operation === "change_speed")
      audio.push(...audioTempo(edit.numerator, edit.denominator));
    if (edit.operation === "normalize_audio") audio.push(loudnessFilter(edit));
    const samples =
      (BigInt(t.totalFrames) * 48000n * BigInt(t.frameRate.denominator) +
        BigInt(Math.floor(t.frameRate.numerator / 2))) /
      BigInt(t.frameRate.numerator);
    audio.push(
      "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
      "apad",
      `atrim=end_sample=${samples}`,
      "asetpts=N/SR/TB",
    );
    validateFilterGraph(audio.join(","));
    args.push(
      "-map",
      "0:a:0",
      "-af",
      audio.join(","),
      "-c:a",
      "aac",
      "-ac",
      "2",
      "-ar",
      "48000",
      "-b:a",
      "192k",
    );
  } else args.push("-an");
  args.push("-movflags", "+faststart", "-fs", "1073741824", "-f", "mp4", localMediaPath(output));
  return Object.freeze(args);
}
export function buildLoudnessMeasureArgs(
  source: EditSource,
  settings: LoudnessSettings,
): readonly string[] {
  if (!source.hasAudio) throw new Error("Normalization requires audio.");
  const filter = loudnessFilter(settings);
  validateFilterGraph(filter);
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "info",
    "-threads",
    "2",
    "-filter_threads",
    "1",
    "-protocol_whitelist",
    "file",
    "-format_whitelist",
    "mov,matroska",
    "-i",
    localMediaPath(source.path),
    "-map",
    "0:a:0",
    "-vn",
    "-af",
    filter,
    "-f",
    "null",
    "-",
  ];
}
export function parseLoudnessMeasurement(
  stderr: string,
): NonNullable<LoudnessSettings["measured"]> {
  const json = stderr.match(/\{\s*"input_i"[\s\S]*?\}/g)?.at(-1);
  if (!json) throw new Error("Missing loudness measurements.");
  const v = JSON.parse(json) as Record<string, unknown>;
  const number = (key: string, min: number, max: number) => {
    const raw = v[key];
    if (typeof raw !== "string" || !/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(raw))
      throw new Error("Unsupported loudness measurement.");
    return boundedNumber(Number(raw), min, max);
  };
  return {
    integrated: number("input_i", -100, 20),
    range: number("input_lra", 0, 100),
    peak: number("input_tp", -100, 30),
    threshold: number("input_thresh", -100, 0),
    offset: number("target_offset", -99, 99),
  };
}

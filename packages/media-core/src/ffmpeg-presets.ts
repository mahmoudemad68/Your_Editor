import { localMediaPath, boundedNumber, buildFfmpegArgs } from "./ffmpeg-builder.js";
export interface DerivativePreset {
  readonly variant: "proxy" | "asr" | "mix" | "poster" | "sprite";
  readonly parameters: Readonly<Record<string, unknown>>;
}
const PROXY_FPS = 30,
  PROXY_GOP = 30,
  SPRITE_SAMPLING_FPS = 30;
/** Frozen US-128 v1 recipes. Parameter identity and output argv stay compatible. */
const MAX_DERIVATIVE_BYTES = 68_719_476_736n;
const DIMENSIONS =
  "scale=w='max(2,trunc(iw*sar*min(1,540/ih)/2)*2)':h='max(2,trunc(ih*min(1,540/ih)/2)*2)',setsar=1";
const THUMB = (w: number, h: number) =>
  `scale=w='max(2,trunc(iw*sar/2)*2)':h=ih,setsar=1,scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`;

export function buildDerivativePreset(
  input: string,
  output: string,
  plan: DerivativePreset,
): readonly string[] {
  localMediaPath(input);
  localMediaPath(output);
  const p = plan.parameters;
  if (typeof p["sourceDurationUs"] !== "string" || !/^[1-9][0-9]{0,9}$/.test(p["sourceDurationUs"]))
    throw new Error("Invalid source duration.");
  if (plan.variant === "poster")
    boundedNumber(p["timestampUs"] as number, 0, Number(p["sourceDurationUs"]), true);
  if (plan.variant === "sprite") {
    const timestamps = p["timestampsUs"];
    if (!Array.isArray(timestamps) || timestamps.length < 1 || timestamps.length > 20)
      throw new Error("Invalid sprite samples.");
    for (const at of timestamps)
      boundedNumber(at as number, 0, Number(p["sourceDurationUs"]), true);
    boundedNumber(p["columns"] as number, 1, 5, true);
    boundedNumber(p["rows"] as number, 1, 20, true);
  }
  const duration = Number(p["sourceDurationUs"]) / 1_000_000;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 1800)
    throw new Error("Invalid derivation duration.");
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-threads",
    "2",
    "-filter_threads",
    "1",
    "-filter_complex_threads",
    "1",
    "-protocol_whitelist",
    "file",
    "-i",
    input,
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
  ];
  switch (plan.variant) {
    case "proxy":
      args.push(
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        `${DIMENSIONS},tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},setpts=PTS-STARTPTS,fps=${PROXY_FPS}:start_time=0:round=near`,
        "-frames:v",
        String(Math.ceil(duration * PROXY_FPS)),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-maxrate",
        "4M",
        "-bufsize",
        "8M",
        "-g",
        String(PROXY_GOP),
        "-keyint_min",
        String(PROXY_GOP),
        "-sc_threshold",
        "0",
        "-threads",
        "2",
        "-fps_mode",
        "cfr",
        "-movflags",
        "+faststart",
        "-metadata:s:v:0",
        "rotate=0",
        "-f",
        "mp4",
      );
      break;
    case "asr":
    case "mix":
      args.push(
        "-map",
        "0:a:0",
        "-vn",
        "-af",
        `aresample=async=1:first_pts=0,apad,atrim=duration=${duration},asetpts=PTS-STARTPTS`,
        "-c:a",
        plan.variant === "asr" ? "pcm_s16le" : "pcm_f32le",
      );
      if (plan.variant === "asr") args.push("-ar", "16000", "-ac", "1");
      args.push("-rf64", "auto", "-f", "wav");
      break;
    case "poster":
      args.push(
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        `tpad=stop_mode=clone:stop_duration=${duration},trim=start=${Number(p["timestampUs"]) / 1_000_000},setpts=PTS-STARTPTS,${THUMB(320, 180)}`,
        "-frames:v",
        "1",
        "-c:v",
        "mjpeg",
        "-q:v",
        "3",
        "-threads",
        "1",
        "-f",
        "image2",
        "-update",
        "1",
      );
      break;
    case "sprite": {
      const timestamps = p["timestampsUs"] as readonly number[];
      const count = timestamps.length;
      // Pad before setpts: the pinned runtime cannot reliably infer tpad's
      // frame duration after PTS reset. Cover even an audio-led source timeline,
      // then explicitly retain each midpoint's
      // nearest CFR frame index. A low-rate fps filter instead emits the end of
      // an interval: start_time does not make it select midpoint pixel content.
      const selected = timestamps
        .map((at) => `eq(n,${Math.round((at * SPRITE_SAMPLING_FPS) / 1_000_000)})`)
        .join("+");
      args.push(
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        `tpad=stop_mode=clone:stop_duration=${duration},setpts=PTS-STARTPTS,fps=${SPRITE_SAMPLING_FPS}:start_time=0:round=near,select='${selected}',${THUMB(160, 90)},tile=${p["columns"]}x${p["rows"]}:nb_frames=${count}`,
        "-frames:v",
        "1",
        "-c:v",
        "mjpeg",
        "-q:v",
        "3",
        "-threads",
        "1",
        "-f",
        "image2",
        "-update",
        "1",
      );
      break;
    }
  }
  if (!["proxy", "asr", "mix", "poster", "sprite"].includes(plan.variant))
    throw new Error("Unsupported derivative preset.");
  // Stops oversized output; stat below rejects truncation as well.
  return [...args, "-fs", MAX_DERIVATIVE_BYTES.toString(), output];
}

export function buildVideoPreset(
  kind: "preview" | "social1080p",
  input: string,
  output: string,
): readonly string[] {
  return buildFfmpegArgs({
    input: { path: input },
    output: {
      path: output,
      format: "mp4",
      maps: ["0:v:0", "0:a:0?"],
      videoEncoder: "libx264",
      audioEncoder: "aac",
      sampleRate: 48000,
      channels: 2,
      videoPreset: kind,
    },
  });
}

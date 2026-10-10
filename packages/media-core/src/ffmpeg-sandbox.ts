import { localMediaPath } from "./ffmpeg-builder.js";
export function sandboxDecodeInput(demuxer: "mov" | "matroska"): string[] {
  if (demuxer !== "mov" && demuxer !== "matroska") throw new Error("Unsupported decode format.");
  const args = [
    "-cpucount",
    "2",
    "-protocol_whitelist",
    "file",
    "-format_whitelist",
    demuxer,
    "-threads",
    "2",
    "-max_alloc",
    "67108864",
    "-probesize",
    "5242880",
    "-analyzeduration",
    "5000000",
    "-f",
    demuxer,
  ];
  if (demuxer === "mov") args.push("-enable_drefs", "0", "-use_absolute_path", "0");
  return args;
}
/** Existing hostile-media decode recipe, run only inside the US-127 native sandbox. */
export function buildSandboxDecodeArgs(
  filePath: string,
  output: string,
  demuxer: "mov" | "matroska",
): readonly string[] {
  localMediaPath(filePath);
  localMediaPath(output);
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-xerror",
    "-err_detect",
    "explode",
    ...sandboxDecodeInput(demuxer),
    "-i",
    filePath,
    "-map",
    "0:v",
    "-map",
    "0:a?",
    "-sn",
    "-dn",
    "-t",
    "1",
    "-frames:v",
    "30",
    "-vf",
    "scale=320:180:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=320:180:(ow-iw)/2:(oh-ih)/2",
    "-filter_threads",
    "1",
    "-c:v",
    "libx264",
    "-threads",
    "2",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-ac",
    "2",
    "-ar",
    "16000",
    "-b:a",
    "32k",
    "-f",
    "mp4",
    output,
  ];
}

import path from "node:path";

/** No URLs, relative paths, option values or control characters at the media boundary. */
export function localMediaPath(value: string): string {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    hasUnsafeControl(value) ||
    value.includes("://") ||
    value.length > 4096
  )
    throw new Error("A controlled absolute local media path is required.");
  return value;
}
export function boundedNumber(value: number, min: number, max: number, integer = false): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isSafeInteger(value))
  )
    throw new Error("Invalid FFmpeg numeric configuration.");
  return value;
}
export function secondsFromUs(value: bigint): string {
  if (typeof value !== "bigint" || value < 0n || value > 9223372036854775807n)
    throw new Error("Invalid media time.");
  return `${value / 1000000n}.${(value % 1000000n).toString().padStart(6, "0")}`;
}
/** Two parser layers: filter-option quoting, then filtergraph escaping. Not shell escaping. */
export function escapeFilterValue(value: string): string {
  if (typeof value !== "string" || value.length > 4096 || hasUnsafeControl(value))
    throw new Error("Invalid filter text.");
  return value.replace(/[\\':]/g, "\\$&").replace(/[\\'[\],;]/g, "\\$&");
}
export type AudioFilter =
  | { readonly kind: "silencedetect"; readonly noiseDb: number; readonly durationUs: bigint }
  | { readonly kind: "ebur128" }
  | { readonly kind: "aresample"; readonly rate: number };
export const FFMPEG_FILTER_ALLOWLIST = [
  "silencedetect",
  "ebur128",
  "aresample",
  "scale",
  "setsar",
  "tpad",
  "trim",
  "setpts",
  "fps",
  "atrim",
  "asetpts",
  "apad",
  "pad",
  "select",
  "tile",
] as const;
export function audioFilterGraph(filters: readonly AudioFilter[]): string {
  if (!Array.isArray(filters) || filters.length < 1 || filters.length > 16)
    throw new Error("Invalid filter graph.");
  return filters
    .map((filter) => {
      switch (filter.kind) {
        case "silencedetect":
          return `silencedetect=noise=${boundedNumber(filter.noiseDb, -100, 0)}dB:d=${secondsFromUs(filter.durationUs)}`;
        case "ebur128":
          return "ebur128=peak=true:framelog=info";
        case "aresample":
          return `aresample=${boundedNumber(filter.rate, 8000, 192000, true)}`;
        default:
          throw new Error("Unsupported FFmpeg filter.");
      }
    })
    .join(",");
}
export interface FfmpegInput {
  readonly path: string;
  readonly format?: "wav" | "mov" | "matroska";
  readonly startUs?: bigint;
  readonly durationUs?: bigint;
}
export interface FfmpegOutput {
  readonly path?: string;
  readonly format: "mp4" | "wav" | "s16le" | "f32le" | "null";
  readonly maps: readonly ("0:a:0" | "0:v:0" | "0:a:0?")[];
  readonly videoEncoder?: "libx264";
  readonly audioEncoder?: "aac" | "pcm_s16le" | "pcm_f32le";
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly audioFilters?: readonly AudioFilter[];
  readonly videoPreset?: "preview" | "social1080p";
}
export interface FfmpegCommand {
  readonly input: FfmpegInput;
  readonly output: FfmpegOutput;
  readonly progress?: boolean;
}
export function buildFfmpegArgs(command: FfmpegCommand): readonly string[] {
  const { input, output } = command;
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
  ];
  if (command.progress) args.push("-progress", "pipe:3", "-nostats");
  if (input.format !== undefined) {
    if (!["wav", "mov", "matroska"].includes(input.format))
      throw new Error("Unsupported input format.");
    args.push("-format_whitelist", input.format, "-f", input.format);
  }
  if (input.startUs !== undefined) args.push("-ss", secondsFromUs(input.startUs));
  if (input.durationUs !== undefined) {
    if (input.durationUs <= 0n || input.durationUs > 1800000000n)
      throw new Error("Invalid input duration.");
    args.push("-t", secondsFromUs(input.durationUs));
  }
  args.push(
    "-i",
    localMediaPath(input.path),
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-sn",
    "-dn",
  );
  if (output.maps.length < 1 || output.maps.length > 2) throw new Error("Invalid stream maps.");
  for (const map of output.maps) {
    if (!["0:a:0", "0:v:0", "0:a:0?"].includes(map)) throw new Error("Unsupported stream map.");
    args.push("-map", map);
  }
  if (output.videoEncoder !== undefined) {
    if (output.videoEncoder !== "libx264") throw new Error("Unsupported video encoder.");
    args.push(
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
    );
  } else args.push("-vn");
  if (output.videoPreset !== undefined) {
    if (output.videoPreset !== "preview" && output.videoPreset !== "social1080p")
      throw new Error("Unsupported video preset.");
    const size = output.videoPreset === "preview" ? "640:360" : "1920:1080";
    args.push(
      "-vf",
      `scale=${size}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${size}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    );
  }
  if (output.audioEncoder !== undefined) {
    if (!["aac", "pcm_s16le", "pcm_f32le"].includes(output.audioEncoder))
      throw new Error("Unsupported audio encoder.");
    args.push("-c:a", output.audioEncoder);
  }
  if (output.sampleRate !== undefined)
    args.push("-ar", String(boundedNumber(output.sampleRate, 8000, 192000, true)));
  if (output.channels !== undefined)
    args.push("-ac", String(boundedNumber(output.channels, 1, 8, true)));
  if (output.audioFilters !== undefined) args.push("-af", audioFilterGraph(output.audioFilters));
  if (!["mp4", "wav", "s16le", "f32le", "null"].includes(output.format))
    throw new Error("Unsupported output format.");
  if (output.format === "mp4") args.push("-movflags", "+faststart");
  args.push(
    "-f",
    output.format,
    output.format === "null"
      ? "-"
      : output.path === undefined
        ? "pipe:1"
        : localMediaPath(output.path),
  );
  return Object.freeze(args);
}

/** Immutable fluent facade; execution accepts only the resulting argv, never shell text. */
export class FfmpegBuilder {
  constructor(private readonly command: FfmpegCommand) {}
  static input(input: FfmpegInput): FfmpegBuilder {
    return new FfmpegBuilder({ input, output: { format: "null", maps: ["0:a:0"] } });
  }
  output(output: FfmpegOutput): FfmpegBuilder {
    return new FfmpegBuilder({ ...this.command, output });
  }
  progress(): FfmpegBuilder {
    return new FfmpegBuilder({ ...this.command, progress: true });
  }
  build(): readonly string[] {
    return buildFfmpegArgs(this.command);
  }
}

export function hasUnsafeControl(value: string): boolean {
  return Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

/** Defense in depth for infrastructure-owned argv: no unsupported raw graph shape. */
export function validateFilterGraph(graph: string): void {
  if (graph.length > 16384 || hasUnsafeControl(graph)) throw new Error("Invalid filter graph.");
  const components: string[] = [];
  let part = "",
    quoted = false,
    escaped = false;
  for (const character of graph) {
    if (escaped) {
      part += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      part += character;
      escaped = true;
      continue;
    }
    if (character === "'") {
      quoted = !quoted;
      part += character;
      continue;
    }
    if (!quoted && (character === ";" || character === "[" || character === "]"))
      throw new Error("Unsupported graph shape.");
    if (!quoted && character === ",") {
      components.push(part);
      part = "";
    } else part += character;
  }
  if (quoted || escaped) throw new Error("Malformed filter graph.");
  components.push(part);
  if (components.length > 32) throw new Error("Unbounded filter graph.");
  for (const component of components) {
    const name = /^([a-z][a-z0-9]*)(?:=|$)/.exec(component)?.[1];
    if (!name || !(FFMPEG_FILTER_ALLOWLIST as readonly string[]).includes(name))
      throw new Error("Unsupported FFmpeg filter.");
  }
}

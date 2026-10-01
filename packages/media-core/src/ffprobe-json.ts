/**
 * Maps an FFprobe JSON document onto the domain probe result.
 * The raw document is not part of the domain model.
 */

import { MediaProbeError, type FrameRateMode, type ProbeResult } from "@editagent/domain";

interface JsonRecord {
  readonly [key: string]: unknown;
}

export function mapFfprobeDocument(document: unknown): ProbeResult {
  if (!isRecord(document)) {
    throw new MediaProbeError("invalid_result");
  }
  const format = isRecord(document["format"]) ? document["format"] : null;
  if (format === null) {
    throw new MediaProbeError("invalid_result");
  }
  const streams = arrayOf(document["streams"]).filter(isRecord);
  const mediaStreams = streams.filter(
    (stream) => stream["codec_type"] === "video" || stream["codec_type"] === "audio",
  );
  if (mediaStreams.length === 0) {
    throw new MediaProbeError("invalid_result");
  }
  const video = mediaStreams.find((stream) => stream["codec_type"] === "video") ?? null;
  const audio = mediaStreams.find((stream) => stream["codec_type"] === "audio") ?? null;
  const rotation = video === null ? null : readRotation(video);
  const width = video === null ? null : readDimension(video["width"]);
  const height = video === null ? null : readDimension(video["height"]);
  if ((width === null) !== (height === null) || (rotation !== null && width === null)) {
    throw new MediaProbeError("invalid_result");
  }
  const swaps = rotation === 90 || rotation === 270;
  return {
    container: containerOf(format["format_name"], format["tags"]),
    videoCodec: video === null ? null : readCodec(video["codec_name"]),
    audioCodec: audio === null ? null : readCodec(audio["codec_name"]),
    width,
    height,
    displayWidth: width === null || height === null ? null : swaps ? height : width,
    displayHeight: width === null || height === null ? null : swaps ? width : height,
    rotation,
    frameRate: video === null ? null : readAverageFrameRate(video["avg_frame_rate"]),
    frameRateMode: classifyFrameRate(document["frames"], video !== null),
    duration: readDuration(format["duration"]),
    colorSpace: video === null ? null : readColorSpace(video["color_space"]),
    audioChannels: audio === null ? null : readCount(audio["channels"]),
    sampleRate: audio === null ? null : readCount(audio["sample_rate"]),
    streams: mediaStreams.map(mapStream),
  };
}

function mapStream(stream: JsonRecord): ProbeResult["streams"][number] {
  const codecType = stream["codec_type"] === "audio" ? "audio" : "video";
  return {
    codecType,
    codecName: readCodec(stream["codec_name"]),
    width: codecType === "video" ? readDimension(stream["width"]) : null,
    height: codecType === "video" ? readDimension(stream["height"]) : null,
    sampleRate: codecType === "audio" ? readCount(stream["sample_rate"]) : null,
    channels: codecType === "audio" ? readCount(stream["channels"]) : null,
  };
}

function containerOf(formatName: unknown, tags: unknown): string | null {
  if (typeof formatName !== "string" || formatName.length === 0) {
    return null;
  }
  const names = formatName.split(",").map((part) => part.trim());
  if (names.includes("webm")) {
    return "WebM";
  }
  if (names.includes("matroska")) {
    return "MKV";
  }
  if (names.includes("wav")) {
    return "WAV";
  }
  if (names.includes("png_pipe") || names.includes("png") || names.includes("image2")) {
    return "PNG";
  }
  if (majorBrand(tags) === "qt") {
    return "MOV";
  }
  if (names.some((name) => name === "mp4" || name === "mov" || name === "isom")) {
    return "MP4";
  }
  return null;
}

function majorBrand(tags: unknown): string | null {
  if (!isRecord(tags) || typeof tags["major_brand"] !== "string") {
    return null;
  }
  const brand = tags["major_brand"].trim().toLowerCase();
  return brand.length === 0 ? null : brand;
}

function readCodec(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new MediaProbeError("invalid_result");
  }
  if (value.trim() === "" || value.trim().toLowerCase() === "unknown") {
    return null;
  }
  return value.trim();
}

function readColorSpace(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new MediaProbeError("invalid_result");
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "unknown" || normalized === "unspecified") {
    return null;
  }
  return value.trim();
}

function readDimension(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new MediaProbeError("invalid_result");
  }
  return value;
}

function readCount(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new MediaProbeError("invalid_result");
  }
  return parsed;
}

function readAverageFrameRate(value: unknown): ProbeResult["frameRate"] {
  if (value === undefined || value === null || value === "0/0") {
    return null;
  }
  if (typeof value !== "string") {
    throw new MediaProbeError("invalid_result");
  }
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (match === null) {
    throw new MediaProbeError("invalid_result");
  }
  const numerator = BigInt(match[1] ?? "0");
  const denominator = BigInt(match[2] ?? "0");
  if (numerator === 0n && denominator === 0n) {
    return null;
  }
  if (numerator <= 0n || denominator <= 0n) {
    throw new MediaProbeError("invalid_result");
  }
  return { numerator, denominator };
}

function readDuration(value: unknown): bigint | null {
  if (value === undefined || value === null || value === "N/A") {
    return null;
  }
  if (typeof value !== "string" || value.startsWith("-")) {
    throw new MediaProbeError("invalid_result");
  }
  const micros = decimalSecondsToMicros(value);
  if (micros === null) {
    throw new MediaProbeError("invalid_result");
  }
  return micros;
}

function readRotation(stream: JsonRecord): number | null {
  const fromMatrix = rotationFromSideData(stream["side_data_list"]);
  if (fromMatrix !== undefined) {
    return fromMatrix;
  }
  return rotationFromTags(stream["tags"]);
}

function rotationFromSideData(value: unknown): number | null | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new MediaProbeError("invalid_result");
  }
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    if (!("rotation" in entry)) {
      continue;
    }
    return normalizeRotation(entry["rotation"]);
  }
  return undefined;
}

function rotationFromTags(value: unknown): number | null {
  if (!isRecord(value) || !("rotate" in value)) {
    return null;
  }
  return normalizeRotation(value["rotate"]);
}

function normalizeRotation(value: unknown): number {
  const numeric =
    typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  if (!Number.isInteger(numeric)) {
    throw new MediaProbeError("invalid_result");
  }
  let degrees = numeric % 360;
  if (degrees < 0) {
    degrees += 360;
  }
  if (degrees !== 0 && degrees !== 90 && degrees !== 180 && degrees !== 270) {
    throw new MediaProbeError("invalid_result");
  }
  return degrees;
}

/**
 * Variable frame rate is decided from video timestamp deltas when at least
 * three timestamps exist. Packet durations are only a fallback. Comparing
 * avg_frame_rate with r_frame_rate is not evidence.
 */
function classifyFrameRate(frames: unknown, hasVideo: boolean): FrameRateMode {
  if (!hasVideo) {
    return "unknown";
  }
  const videoFrames = arrayOf(frames)
    .filter(isRecord)
    .filter((frame) => frame["media_type"] === "video");
  const timestamps: bigint[] = [];
  for (const frame of videoFrames) {
    const raw = frame["best_effort_timestamp_time"];
    if (typeof raw !== "string") {
      continue;
    }
    const micros = decimalSecondsToMicros(raw);
    if (micros === null) {
      return "unknown";
    }
    timestamps.push(micros);
  }
  if (timestamps.length >= 3) {
    return classifyDeltas(timestamps);
  }
  const packets: bigint[] = [];
  for (const frame of videoFrames) {
    const raw = frame["pkt_duration"];
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
      continue;
    }
    packets.push(BigInt(raw));
  }
  if (packets.length >= 3) {
    return classifySpread(packets);
  }
  return "unknown";
}

function classifyDeltas(timestamps: readonly bigint[]): FrameRateMode {
  const deltas: bigint[] = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    const current = timestamps[index];
    const previous = timestamps[index - 1];
    if (current === undefined || previous === undefined) {
      return "unknown";
    }
    const delta = current - previous;
    if (delta <= 0n) {
      return "unknown";
    }
    deltas.push(delta);
  }
  return classifySpread(deltas);
}

function classifySpread(values: readonly bigint[]): FrameRateMode {
  const first = values[0];
  if (first === undefined || values.length < 2) {
    return "unknown";
  }
  let min = first;
  let max = first;
  for (const value of values) {
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
  }
  if (max === min) {
    return "constant";
  }
  if (max * 2n > min * 3n) {
    return "variable";
  }
  return "unknown";
}

function decimalSecondsToMicros(value: string): bigint | null {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    return null;
  }
  const [whole, fraction = ""] = value.split(".");
  const micros = `${fraction}000000`.slice(0, 6);
  return BigInt(whole ?? "0") * 1_000_000n + BigInt(micros);
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

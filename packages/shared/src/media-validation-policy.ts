import { createHash } from "node:crypto";
import { ConfigurationError, type EnvSource } from "./config.js";

// A finite job budget covering the maximum supported probe/decode deadlines,
// 90s acquisition, 30s hashing, 15s lock wait, 5s startup, 5s persistence,
// 5s cleanup, plus 30s supervision/queue reserve. Stages share this wall deadline.
export const MAX_VALIDATION_SUBPROCESS_TIMEOUT_MS = 60_000;
export const MEDIA_INSPECT_OPERATIONAL_HEADROOM_MS = 150_000;
export const MEDIA_INSPECT_TIMEOUT_MS =
  2 * MAX_VALIDATION_SUBPROCESS_TIMEOUT_MS + MEDIA_INSPECT_OPERATIONAL_HEADROOM_MS + 30_000;

export function assertInspectionTimeoutBudget(policy: ValidationPolicy): void {
  if (
    policy.probeTimeoutMs + policy.decodeTimeoutMs + MEDIA_INSPECT_OPERATIONAL_HEADROOM_MS >=
    MEDIA_INSPECT_TIMEOUT_MS
  )
    throw new ConfigurationError(
      "Media worker",
      "Inspection deadline has insufficient operational headroom.",
    );
}

export const VIDEO_CODECS = ["h264", "hevc", "vp9", "av1"] as const;
export const AUDIO_CODECS = [
  "aac",
  "opus",
  "pcm_s16le",
  "pcm_s16be",
  "pcm_s24le",
  "pcm_s32le",
  "pcm_f32le",
  "pcm_u8",
] as const;
export interface ValidationPolicy {
  readonly maxBytes: number;
  readonly maxDurationSeconds: number;
  readonly maxDimension: number;
  readonly maxPixels: number;
  readonly maxStreams: number;
  readonly maxBitrate: number;
  readonly probeTimeoutMs: number;
  readonly decodeTimeoutMs: number;
  readonly cpuSeconds: number;
  readonly memoryBytes: number;
  readonly decodeOutputBytes: number;
}
export function parseValidationPolicy(env: EnvSource): ValidationPolicy {
  function limit(key: string, value: number, min: number, max: number): number {
    const raw = env[`MEDIA_VALIDATION_${key}`];
    if (raw === undefined) return value;
    if (
      !/^[1-9]\d*$/.test(raw) ||
      !Number.isSafeInteger(Number(raw)) ||
      Number(raw) < min ||
      Number(raw) > max
    )
      throw new ConfigurationError(
        "Media worker",
        `MEDIA_VALIDATION_${key} is outside its bounded range.`,
      );
    return Number(raw);
  }
  const policy = Object.freeze({
    maxBytes: limit("MAX_BYTES", 4294967296, 1, 4294967296),
    maxDurationSeconds: limit("MAX_DURATION_SECONDS", 1800, 1, 1800),
    maxDimension: limit("MAX_DIMENSION", 4096, 2, 8192),
    maxPixels: limit("MAX_PIXELS", 8847360, 4, 33177600),
    maxStreams: limit("MAX_STREAMS", 8, 1, 32),
    maxBitrate: limit("MAX_BITRATE", 100000000, 1000, 1000000000),
    probeTimeoutMs: limit("PROBE_TIMEOUT_MS", 15000, 100, MAX_VALIDATION_SUBPROCESS_TIMEOUT_MS),
    decodeTimeoutMs: limit("DECODE_TIMEOUT_MS", 15000, 100, MAX_VALIDATION_SUBPROCESS_TIMEOUT_MS),
    cpuSeconds: limit("CPU_SECONDS", 10, 1, 60),
    memoryBytes: limit("MEMORY_BYTES", 1073741824, 134217728, 2147483648),
    decodeOutputBytes: limit("DECODE_OUTPUT_BYTES", 16777216, 1048576, 67108864),
  });
  assertInspectionTimeoutBudget(policy);
  return policy;
}
export function validationPolicySignature(policy: ValidationPolicy): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: "us127-v1",
        containers: ["mp4", "mov", "mkv", "webm"],
        video: VIDEO_CODECS,
        audio: AUDIO_CODECS,
        decode: { seconds: 1, frames: 30, threads: 2 },
        maxBytes: policy.maxBytes,
        maxDurationSeconds: policy.maxDurationSeconds,
        maxDimension: policy.maxDimension,
        maxPixels: policy.maxPixels,
        maxStreams: policy.maxStreams,
        maxBitrate: policy.maxBitrate,
        probeTimeoutMs: policy.probeTimeoutMs,
        decodeTimeoutMs: policy.decodeTimeoutMs,
        cpuSeconds: policy.cpuSeconds,
        memoryBytes: policy.memoryBytes,
        decodeOutputBytes: policy.decodeOutputBytes,
      }),
    )
    .digest("hex");
}

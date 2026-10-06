import { createHash } from "node:crypto";
import { ConfigurationError, type EnvSource } from "@editagent/shared";

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
  return Object.freeze({
    maxBytes: limit("MAX_BYTES", 4294967296, 1, 4294967296),
    maxDurationSeconds: limit("MAX_DURATION_SECONDS", 1800, 1, 1800),
    maxDimension: limit("MAX_DIMENSION", 4096, 2, 8192),
    maxPixels: limit("MAX_PIXELS", 8847360, 4, 33177600),
    maxStreams: limit("MAX_STREAMS", 8, 1, 32),
    maxBitrate: limit("MAX_BITRATE", 100000000, 1000, 1000000000),
    probeTimeoutMs: limit("PROBE_TIMEOUT_MS", 15000, 100, 60000),
    decodeTimeoutMs: limit("DECODE_TIMEOUT_MS", 15000, 100, 60000),
    cpuSeconds: limit("CPU_SECONDS", 10, 1, 60),
    memoryBytes: limit("MEMORY_BYTES", 1073741824, 134217728, 2147483648),
    decodeOutputBytes: limit("DECODE_OUTPUT_BYTES", 16777216, 1048576, 67108864),
  });
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
        ...policy,
      }),
    )
    .digest("hex");
}

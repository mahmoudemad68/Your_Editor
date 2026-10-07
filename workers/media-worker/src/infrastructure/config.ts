import { stat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  ConfigurationError,
  parseMediaWorkerConfig,
  WORKER_HEALTH_PORT,
  type EnvSource,
  type StorageWorkerConfig,
} from "@editagent/shared";

export type { StorageWorkerConfig };
export { ConfigurationError } from "@editagent/shared";

import { parseValidationPolicy, type ValidationPolicy } from "../application/validation-policy.js";

export interface MediaWorkerConfig extends StorageWorkerConfig {
  readonly ffprobePath: string;
  readonly ffmpegPath: string;
  readonly validationPolicy: ValidationPolicy;
  readonly ffprobeTimeoutMs: number;
  readonly probeTmpDir: string | null;
  readonly mediaInspectQueue: string;
  readonly healthPort: number;
}

/** Process boundary for media-worker configuration. Reads the environment once. */
export function loadMediaWorkerConfig(env: EnvSource = process.env): MediaWorkerConfig {
  const base = parseMediaWorkerConfig(env);
  const ffmpegPath = env["FFMPEG_PATH"] || "ffmpeg";
  if (ffmpegPath.includes("\0"))
    throw new ConfigurationError("Media worker", "FFMPEG_PATH is not valid.");
  if (env["ALLOW_UNVALIDATED_DERIVATION"] === "true")
    throw new ConfigurationError("Media worker", "Unvalidated derivation is no longer permitted.");
  return {
    ...base,
    ...parseProbeRuntime(env),
    ...parseWorkerRuntime(env),
    ffmpegPath,
    validationPolicy: parseValidationPolicy(env),
  };
}

function parseProbeRuntime(env: EnvSource): {
  ffprobePath: string;
  ffprobeTimeoutMs: number;
  probeTmpDir: string | null;
} {
  const configuredPath = env["FFPROBE_PATH"];
  const ffprobePath =
    configuredPath === undefined || configuredPath.length === 0 ? "ffprobe" : configuredPath;
  if (ffprobePath.includes("\0")) {
    throw new ConfigurationError("Media worker", "FFPROBE_PATH is not valid.");
  }
  const timeoutRaw = env["FFPROBE_TIMEOUT_MS"];
  let ffprobeTimeoutMs = 30_000;
  if (timeoutRaw !== undefined && timeoutRaw.length > 0) {
    if (!/^[1-9]\d*$/.test(timeoutRaw) || Number(timeoutRaw) > 600_000) {
      throw new ConfigurationError(
        "Media worker",
        "FFPROBE_TIMEOUT_MS must be a positive integer.",
      );
    }
    ffprobeTimeoutMs = Number(timeoutRaw);
  }
  const tmp = env["PROBE_TMPDIR"];
  const probeTmpDir = tmp === undefined || tmp.length === 0 ? null : tmp;
  if (probeTmpDir !== null && !probeTmpDir.startsWith("/")) {
    throw new ConfigurationError("Media worker", "PROBE_TMPDIR must be an absolute path.");
  }
  return { ffprobePath, ffprobeTimeoutMs, probeTmpDir };
}

function parseWorkerRuntime(env: EnvSource): { mediaInspectQueue: string; healthPort: number } {
  const configured = env["MEDIA_INSPECT_QUEUE"];
  const mediaInspectQueue =
    configured === undefined || configured.length === 0 ? "media" : configured;
  if (
    mediaInspectQueue.includes(":") ||
    mediaInspectQueue !== mediaInspectQueue.trim() ||
    mediaInspectQueue.length > 64
  ) {
    throw new ConfigurationError(
      "Media worker",
      "MEDIA_INSPECT_QUEUE must be a short name without a colon.",
    );
  }
  const rawPort = env["WORKER_HEALTH_PORT"];
  if (rawPort === undefined || rawPort.length === 0) {
    return { mediaInspectQueue, healthPort: WORKER_HEALTH_PORT };
  }
  if (!/^\d+$/.test(rawPort) || Number(rawPort) > 65535) {
    throw new ConfigurationError("Media worker", "WORKER_HEALTH_PORT must be a port.");
  }
  return { mediaInspectQueue, healthPort: Number(rawPort) };
}

export async function executablePath(value: string): Promise<string> {
  if (value.includes("\0") || value.includes("\n")) throw new Error("Invalid media executable.");
  const candidates = path.isAbsolute(value)
    ? [value]
    : (process.env["PATH"] ?? "").split(path.delimiter).map((dir) => path.resolve(dir, value));
  for (const p of candidates) {
    try {
      const s = await stat(p);
      if (s.isFile() && (s.mode & 0o111) !== 0) return await realpath(p);
    } catch {
      /* Continue trusted executable search. */
    }
  }
  throw new Error("Required media executable is unavailable.");
}

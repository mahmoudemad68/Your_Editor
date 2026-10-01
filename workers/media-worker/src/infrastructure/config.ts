import {
  ConfigurationError,
  parseMediaWorkerConfig,
  type EnvSource,
  type StorageWorkerConfig,
} from "@editagent/shared";

export type { StorageWorkerConfig };
export { ConfigurationError } from "@editagent/shared";

export interface MediaWorkerConfig extends StorageWorkerConfig {
  readonly ffprobePath: string;
  readonly ffprobeTimeoutMs: number;
  readonly probeTmpDir: string | null;
}

/** Process boundary for media-worker configuration. Reads the environment once. */
export function loadMediaWorkerConfig(env: EnvSource = process.env): MediaWorkerConfig {
  const base = parseMediaWorkerConfig(env);
  return { ...base, ...parseProbeRuntime(env) };
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

import {
  parseMediaWorkerConfig,
  type EnvSource,
  type StorageWorkerConfig,
} from "@editagent/shared";

export type { StorageWorkerConfig };
export { ConfigurationError } from "@editagent/shared";

/** Process boundary for media-worker configuration. Reads the environment once. */
export function loadMediaWorkerConfig(env: EnvSource = process.env): StorageWorkerConfig {
  return parseMediaWorkerConfig(env);
}

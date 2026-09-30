import {
  parseRenderWorkerConfig,
  type EnvSource,
  type StorageWorkerConfig,
} from "@editagent/shared";

export type { StorageWorkerConfig };
export { ConfigurationError } from "@editagent/shared";

/** Process boundary for render-worker configuration. Reads the environment once. */
export function loadRenderWorkerConfig(env: EnvSource = process.env): StorageWorkerConfig {
  return parseRenderWorkerConfig(env);
}

import { parseWebConfig, type EnvSource, type WebConfig } from "@editagent/shared";

export type { WebConfig };
export { ConfigurationError } from "@editagent/shared";

/** Process boundary for web configuration. The web process has no database credentials. */
export function loadWebConfig(env: EnvSource = process.env): WebConfig {
  return parseWebConfig(env);
}

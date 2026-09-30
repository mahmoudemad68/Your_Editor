import { parseApiConfig, type ApiConfig, type EnvSource } from "@editagent/shared";

export type { ApiConfig };
export { ConfigurationError } from "@editagent/shared";

/** Process boundary for API configuration. Reads the environment once. */
export function loadApiConfig(env: EnvSource = process.env): ApiConfig {
  return parseApiConfig(env);
}

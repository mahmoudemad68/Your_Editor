import {
  ConfigurationError,
  parseApiConfig,
  parseValidationPolicy,
  type ValidationPolicy,
  type ApiConfig,
  type EnvSource,
} from "@editagent/shared";

export type { ApiConfig };
export { ConfigurationError };

export interface ApiRuntimeConfig extends ApiConfig {
  readonly mediaInspectQueue: string;
  readonly validationPolicy: ValidationPolicy;
}

/** Process boundary for API configuration. Reads the environment once. */
export function loadApiConfig(env: EnvSource = process.env): ApiRuntimeConfig {
  return {
    ...parseApiConfig(env),
    mediaInspectQueue: parseMediaInspectQueue(env),
    validationPolicy: parseValidationPolicy(env),
  };
}

function parseMediaInspectQueue(env: EnvSource): string {
  const configured = env["MEDIA_INSPECT_QUEUE"];
  const queueName = configured === undefined || configured.length === 0 ? "media" : configured;
  if (queueName.includes(":") || queueName !== queueName.trim() || queueName.length > 64) {
    throw new ConfigurationError(
      "API",
      "MEDIA_INSPECT_QUEUE must be a short name without a colon.",
    );
  }
  return queueName;
}

import { parseAgentWorkerConfig, type AgentWorkerConfig, type EnvSource } from "@editagent/shared";

export type { AgentWorkerConfig };
export { ConfigurationError } from "@editagent/shared";

/** Process boundary for agent-worker configuration. Reads the environment once. */
export function loadAgentWorkerConfig(env: EnvSource = process.env): AgentWorkerConfig {
  return parseAgentWorkerConfig(env);
}

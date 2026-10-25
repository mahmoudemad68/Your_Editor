import { parseAgentWorkerConfig, type AgentWorkerConfig, type EnvSource } from "@editagent/shared";
import { ConfigurationError } from "@editagent/shared";

export type { AgentWorkerConfig };
export { ConfigurationError } from "@editagent/shared";

/** Process boundary for agent-worker configuration. Reads the environment once. */
export function loadAgentWorkerConfig(env: EnvSource = process.env): AgentWorkerConfig {
  return parseAgentWorkerConfig(env);
}
/** Fixed allowlisted diagnostics; never echo validation input or exception text. */
export function agentStartupMessage(error: unknown, env: EnvSource = process.env): string {
  if (!(error instanceof ConfigurationError)) return "agent_worker_start_failed";
  if (!env.DATABASE_URL?.trim())
    return "Agent worker configuration error. DATABASE_URL is required.";
  if (!env.REDIS_URL?.trim()) return "Agent worker configuration error. REDIS_URL is required.";
  return "Agent worker configuration error. Check database, Redis and optional provider settings.";
}

import { parseAgentWorkerConfig, type AgentWorkerConfig, type EnvSource } from "@editagent/shared";
import { ConfigurationError } from "@editagent/shared";
import { createControlledReplayPermit } from "@editagent/agent-core";

export type { AgentWorkerConfig };
export { ConfigurationError } from "@editagent/shared";

/** Process boundary for agent-worker configuration. Reads the environment once. */
export function loadAgentWorkerConfig(env: EnvSource = process.env): AgentWorkerConfig {
  return parseAgentWorkerConfig(env);
}
/** Only the separately invoked isolated runner calls this loader. Normal main
 * never selects a planner from these flags. Keys/provider URLs are not read. */
export function loadControlledReplayConfig(env: EnvSource = process.env) {
  const permit = createControlledReplayPermit({
    nodeEnvironment: env.NODE_ENV,
    runtime: env.EDITAGENT_RUNTIME,
    qualification: env.EDITAGENT_REPLAY_QUALIFICATION,
  });
  if (!env.DATABASE_URL?.trim() || !env.REDIS_URL?.trim())
    throw new ConfigurationError(
      "agent-worker",
      "Isolated database and Redis configuration are required.",
    );
  return Object.freeze({
    permit,
    databaseUrl: env.DATABASE_URL.trim(),
    redisUrl: env.REDIS_URL.trim(),
  });
}
/** Fixed allowlisted diagnostics; never echo validation input or exception text. */
export function agentStartupMessage(error: unknown, env: EnvSource = process.env): string {
  if (!(error instanceof ConfigurationError)) return "agent_worker_start_failed";
  if (!env.DATABASE_URL?.trim())
    return "Agent worker configuration error. DATABASE_URL is required.";
  if (!env.REDIS_URL?.trim()) return "Agent worker configuration error. REDIS_URL is required.";
  return "Agent worker configuration error. Check database, Redis and optional provider settings.";
}

import { AgentError } from "./contracts.js";

/** In-process composition capability, never serialized or admitted over HTTP.
 * The process configuration boundary supplies these facts. Production composition
 * never creates this permit, even if replay-like fields appear in a request. */
export interface ControlledReplayPermit {
  readonly mode: "isolated-replay-v1";
}
const issued = new WeakSet<object>();
export function createControlledReplayPermit(configuration: {
  nodeEnvironment: string | undefined;
  runtime: string | undefined;
  qualification: string | undefined;
}): ControlledReplayPermit {
  if (
    configuration.nodeEnvironment !== "test" ||
    configuration.runtime !== "development" ||
    configuration.qualification !== "isolated-v1"
  )
    throw new AgentError("forbidden");
  const permit = Object.freeze({ mode: "isolated-replay-v1" as const });
  issued.add(permit);
  return permit;
}
export function assertControlledReplayPermit(permit: ControlledReplayPermit | undefined): void {
  if (!permit || !issued.has(permit)) throw new AgentError("forbidden");
}

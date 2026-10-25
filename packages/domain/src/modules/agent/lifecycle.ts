import { DomainError } from "../../kernel/error.js";

export const AGENT_STATES = [
  "Pending",
  "Observing",
  "Planning",
  "Executing",
  "Rendering",
  "Evaluating",
  "Completed",
  "Failed",
  "Cancelled",
] as const;
export type AgentState = (typeof AGENT_STATES)[number];
export const AGENT_STOP_REASONS = [
  "PLANNER_NOT_CONFIGURED",
  "CANCELLED",
  "ACCESS_REVOKED",
  "DEADLINE_EXCEEDED",
  "EXECUTION_UNCONFIRMED",
  "TOOL_FAILED",
  "STALE_SOURCE",
  "STEP_LIMIT",
  "INTERNAL",
] as const;
export type AgentStopReason = (typeof AGENT_STOP_REASONS)[number];
const transitions: Record<AgentState, readonly AgentState[]> = {
  Pending: ["Observing"],
  Observing: ["Planning"],
  Planning: ["Executing"],
  Executing: ["Rendering", "Evaluating"],
  Rendering: ["Evaluating"],
  Evaluating: ["Completed"],
  Completed: [],
  Failed: [],
  Cancelled: [],
};
export function agentTerminal(state: AgentState): boolean {
  return state === "Completed" || state === "Failed" || state === "Cancelled";
}
export function assertAgentTransition(
  from: AgentState,
  to: AgentState,
  reason: AgentStopReason | null,
): void {
  if (
    !AGENT_STATES.includes(from) ||
    !AGENT_STATES.includes(to) ||
    agentTerminal(from) ||
    !(transitions[from].includes(to) || to === "Failed" || to === "Cancelled") ||
    (to === "Cancelled"
      ? reason !== "CANCELLED"
      : to === "Failed"
        ? reason === null || reason === "CANCELLED"
        : reason !== null) ||
    (reason !== null && !AGENT_STOP_REASONS.includes(reason))
  )
    throw new DomainError("Invalid AgentRun transition.");
}

import {
  AGENT_STATES,
  AGENT_STOP_REASONS,
  uuidV7,
  type AgentState,
  type AgentStopReason,
  type EditCommand,
} from "@editagent/domain";
import { AgentRunSchema, type ModelAuditV1, type PlanningStop } from "@editagent/schemas";
export {
  agentRunCurrentOpenApiSchema as agentRunOpenApiSchema,
  agentEventCurrentOpenApiSchema as agentStepEventOpenApiSchema,
  agentAuditCurrentOpenApiSchema as agentAuditPageOpenApiSchema,
  agentExportCurrentOpenApiSchema as agentExportOpenApiSchema,
} from "@editagent/schemas";

export const AGENT_QUEUE = "agent-runs-v1";
export const AGENT_JOB_TYPE = "agent.run.v1";
export const AGENT_DEADLINE_MS = 120_000;
export const AGENT_MAX_STEPS = 64;
export class AgentError extends Error {
  constructor(readonly code: "not_found" | "forbidden" | "invalid_input" | "conflict" | "fenced") {
    super(code);
  }
}
export interface AgentRunView {
  schemaVersion: "1.0.0" | "1.1.0";
  id: string;
  projectId: string;
  state: AgentState;
  revision: number;
  sequence: number;
  checkpoint: number;
  generation: number;
  stopReason: AgentStopReason | null;
  createdAtMs: number;
  updatedAtMs: number;
  deadlineAtMs: number;
  source: { timelineId: string; stateSha256: string } | null;
  runtime:
    | { driver: "infrastructure-v1"; planner: "not_configured" }
    | { driver: "controlled-loop-v1"; planner: "replay_only" };
  planning?: {
    schemaVersion: "1.0.0";
    stopReason: PlanningStop | null;
    renderJobId: string | null;
    toolAttempts: number;
  };
}
export interface AgentEvent {
  schemaVersion: "1.0.0" | "1.1.0";
  id: string;
  runId: string;
  sequence: number;
  revision: number;
  state: AgentState;
  kind:
    | "admitted"
    | "transition"
    | "tool_intent"
    | "tool_result"
    | "recovered"
    | "model_intent"
    | "model_result"
    | "planning_feedback"
    | "plan_committed"
    | "render_intent"
    | "render_result";
  summary:
    | "RUN_ADMITTED"
    | "STATE_CHANGED"
    | "TOOL_STARTED"
    | "TOOL_FINISHED"
    | "CHECKPOINT_RESTORED"
    | "MODEL_STARTED"
    | "MODEL_FINISHED"
    | "PLAN_REJECTED"
    | "PLAN_COMMITTED"
    | "RENDER_STARTED"
    | "RENDER_FINISHED";
  atMs: number;
  correlationId: string;
  requestCorrelationSha256: string;
  stopReason: AgentStopReason | null;
  tool: {
    name: string;
    version: string;
    inputSha256: string;
    outputSha256: string | null;
    receiptId: string;
    outcome: "running" | "succeeded" | "failed" | "unconfirmed";
    durationMs: number | null;
    costMicros: number | null;
  } | null;
  tokens: { input: number | null; output: number | null } | null;
  tokenMeasurement:
    | "not_applicable"
    | "provider_reported"
    | "offline_http_fixture"
    | "synthetic_replay"
    | "unavailable";
  decision: "no_llm" | "runtime" | "model" | "tool_execution";
  model?: ModelAuditV1 | null;
}
export interface AuditPage {
  schemaVersion: "1.0.0" | "1.1.0";
  run: AgentRunView;
  events: AgentEvent[];
  nextCursor: string | null;
  throughSequence: number;
}
export interface AgentExport extends AuditPage {
  replay: {
    mode: "apply_commands_to_original_snapshot_only";
    source: AgentRunView["source"];
    commands: readonly {
      stepId: string;
      receiptId: string;
      basisSha256: string;
      resultSha256: string;
      commands: readonly EditCommand[];
    }[];
    effects: "never_reexecute_tools";
  };
}
export interface AgentApi {
  start(
    actor: string,
    project: string,
    input: unknown,
    correlationId: string,
  ): Promise<AgentRunView>;
  get(actor: string, project: string, id: string): Promise<AgentRunView>;
  cancel(actor: string, project: string, id: string): Promise<AgentRunView>;
  audit(
    actor: string,
    project: string,
    id: string,
    cursor?: string,
    limit?: number,
  ): Promise<AuditPage>;
  export(
    actor: string,
    project: string,
    id: string,
    cursor?: string,
    limit?: number,
  ): Promise<AgentExport>;
  events(actor: string, project: string, id: string, after?: string): Promise<AgentEvent[]>;
}
export function checkedUuid(value: string): string {
  try {
    return uuidV7(value);
  } catch {
    throw new AgentError("invalid_input");
  }
}
export function assertRun(value: AgentRunView): AgentRunView {
  if (!AgentRunSchema.safeParse(value).success) throw new AgentError("invalid_input");
  checkedUuid(value.id);
  checkedUuid(value.projectId);
  if (
    !["1.0.0", "1.1.0"].includes(value.schemaVersion) ||
    !AGENT_STATES.includes(value.state) ||
    (value.stopReason !== null && !AGENT_STOP_REASONS.includes(value.stopReason)) ||
    ![
      value.revision,
      value.sequence,
      value.checkpoint,
      value.generation,
      value.createdAtMs,
      value.updatedAtMs,
      value.deadlineAtMs,
    ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    value.checkpoint > AGENT_MAX_STEPS ||
    (value.source !== null && !/^[a-f0-9]{64}$/.test(value.source.stateSha256))
  )
    throw new AgentError("invalid_input");
  return value;
}

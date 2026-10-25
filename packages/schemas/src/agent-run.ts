import { z } from "zod";

const id = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const state = z.enum([
  "Pending",
  "Observing",
  "Planning",
  "Executing",
  "Rendering",
  "Evaluating",
  "Completed",
  "Failed",
  "Cancelled",
]);
const stop = z
  .enum([
    "PLANNER_NOT_CONFIGURED",
    "CANCELLED",
    "ACCESS_REVOKED",
    "DEADLINE_EXCEEDED",
    "EXECUTION_UNCONFIRMED",
    "TOOL_FAILED",
    "STALE_SOURCE",
    "STEP_LIMIT",
    "INTERNAL",
  ])
  .nullable();
export const AgentRunV1Schema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  id,
  projectId: id,
  state,
  revision: count,
  sequence: count.max(256),
  checkpoint: count.max(64),
  generation: count,
  stopReason: stop,
  createdAtMs: count,
  updatedAtMs: count,
  deadlineAtMs: count,
  source: z.strictObject({ timelineId: id, stateSha256: hash }).nullable(),
  runtime: z.strictObject({
    driver: z.literal("infrastructure-v1"),
    planner: z.literal("not_configured"),
  }),
});
const tool = z.strictObject({
  name: z.enum(["editing.trim-video", "editing.split-video"]),
  version: z.literal("1.0.0"),
  inputSha256: hash,
  outputSha256: hash.nullable(),
  receiptId: id,
  outcome: z.enum(["running", "succeeded", "failed", "unconfirmed"]),
  durationMs: count.nullable(),
  costMicros: count.nullable(),
});
export const AgentStepEventV1Schema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  id,
  runId: id,
  sequence: count.min(1).max(256),
  revision: count,
  state,
  kind: z.enum(["admitted", "transition", "tool_intent", "tool_result", "recovered"]),
  summary: z.enum([
    "RUN_ADMITTED",
    "STATE_CHANGED",
    "TOOL_STARTED",
    "TOOL_FINISHED",
    "CHECKPOINT_RESTORED",
  ]),
  atMs: count,
  correlationId: id,
  requestCorrelationSha256: hash,
  stopReason: stop,
  tool: tool.nullable(),
  tokens: z.null(),
  tokenMeasurement: z.literal("not_applicable"),
  decision: z.literal("no_llm"),
});
export const AgentStepV1Schema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  id,
  runId: id,
  ordinal: count.max(63),
  receiptId: id,
  name: z.enum(["editing.trim-video", "editing.split-video"]),
  version: z.literal("1.0.0"),
  inputSha256: hash,
});
export type AgentRunV1 = z.infer<typeof AgentRunV1Schema>;
export type AgentStepEventV1 = z.infer<typeof AgentStepEventV1Schema>;
export const agentRunOpenApiSchema = z.toJSONSchema(AgentRunV1Schema, { target: "openapi-3.0" });
export const agentStepEventOpenApiSchema = z.toJSONSchema(AgentStepEventV1Schema, {
  target: "openapi-3.0",
});

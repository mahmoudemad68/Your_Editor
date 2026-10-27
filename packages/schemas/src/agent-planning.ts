import { z } from "zod";
import {
  AgentRunV1Schema,
  AgentStepEventV1Schema,
  AgentAuditPageV1Schema,
  AgentExportV1Schema,
} from "./agent-run.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tag = z.string().regex(/^[a-zA-Z0-9_.:/-]{1,100}$/);
export const PlanningStopSchema = z.enum([
  "PROVIDER_INVALID_RESPONSE",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_OUTCOME_UNCONFIRMED",
  "PROVIDER_REFUSED",
  "PLAN_INVALID",
  "CAPABILITY_UNAVAILABLE",
  "ITERATION_BUDGET",
  "TOOL_BUDGET",
  "TOKEN_BUDGET",
  "COST_BUDGET",
  "RENDER_FAILED",
  "RENDER_UNCONFIRMED",
  "OUTPUT_INVALID",
  "ANALYSIS_UNAVAILABLE",
]);
export type PlanningStop = z.infer<typeof PlanningStopSchema>;
export const ProviderReceiptV1Schema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  provider: z.enum(["openai-compatible", "anthropic", "replay"]),
  modelId: tag,
  modelVersion: tag,
  profileSha256: hash,
  configurationVersion: tag,
  requestSha256: hash,
  transportProfileSha256: hash.nullable(),
  requestIdSha256: hash.nullable(),
  mode: z.enum(["chat", "tools", "structured", "vision"]),
  evidence: z.enum(["operator_declared_unqualified", "offline_http_fixture", "synthetic_replay"]),
  usage: z.strictObject({
    source: z.enum([
      "provider_reported",
      "offline_http_fixture",
      "synthetic_replay",
      "unavailable",
    ]),
    inputTokens: count.nullable(),
    outputTokens: count.nullable(),
    actualCostMicros: z.null(),
    tokenAccounting: z.enum([
      "provider_reported_total",
      "native_input_and_cache_sum",
      "synthetic_replay",
      "unavailable",
    ]),
  }),
  estimatedInputTokens: count,
  estimatedCostMicros: count.nullable(),
  pricingVersion: tag.nullable(),
  attempts: count.min(1).max(3),
  durationMs: count,
  deadlineAtMs: count,
});
export const ModelAuditV1Schema = z.strictObject({
  callId: id,
  providerProfile: ProviderReceiptV1Schema.pick({
    provider: true,
    modelId: true,
    modelVersion: true,
    configurationVersion: true,
    profileSha256: true,
    evidence: true,
  }),
  ordinal: count.max(15),
  requestSha256: hash,
  contextSha256: hash,
  promptId: tag,
  promptVersion: tag,
  templateHash: hash,
  outcome: z.enum(["running", "succeeded", "failed", "unconfirmed"]),
  reservation: z.strictObject({ tokens: count, costMicros: count }),
  receipt: ProviderReceiptV1Schema.nullable(),
  failure: z
    .enum([
      "invalid_response",
      "refused",
      "truncated",
      "cancelled",
      "timeout",
      "rate_limited",
      "unavailable",
      "authentication",
      "transport_unknown",
      "budget_exceeded",
      "invalid_request",
      "unsupported_mode",
      "endpoint_denied",
    ])
    .nullable(),
});
export const AgentRunV1_1Schema = AgentRunV1Schema.extend({
  schemaVersion: z.literal("1.1.0"),
  runtime: z.strictObject({
    driver: z.literal("controlled-loop-v1"),
    planner: z.literal("replay_only"),
  }),
  planning: z.strictObject({
    schemaVersion: z.literal("1.0.0"),
    stopReason: PlanningStopSchema.nullable(),
    renderJobId: id.nullable(),
    toolAttempts: count.max(64),
  }),
});
export const AgentRunSchema = z.union([AgentRunV1Schema, AgentRunV1_1Schema]);
export const AgentStepEventV1_1Schema = AgentStepEventV1Schema.extend({
  schemaVersion: z.literal("1.1.0"),
  kind: z.enum([
    "admitted",
    "transition",
    "tool_intent",
    "tool_result",
    "recovered",
    "model_intent",
    "model_result",
    "planning_feedback",
    "plan_committed",
    "render_intent",
    "render_result",
  ]),
  summary: z.enum([
    "RUN_ADMITTED",
    "STATE_CHANGED",
    "TOOL_STARTED",
    "TOOL_FINISHED",
    "CHECKPOINT_RESTORED",
    "MODEL_STARTED",
    "MODEL_FINISHED",
    "PLAN_REJECTED",
    "PLAN_COMMITTED",
    "RENDER_STARTED",
    "RENDER_FINISHED",
  ]),
  tokens: z.strictObject({ input: count.nullable(), output: count.nullable() }).nullable(),
  tokenMeasurement: z.enum([
    "not_applicable",
    "provider_reported",
    "offline_http_fixture",
    "synthetic_replay",
    "unavailable",
  ]),
  decision: z.enum(["runtime", "model", "tool_execution"]),
  model: ModelAuditV1Schema.nullable(),
});
export const AgentStepEventSchema = z.union([AgentStepEventV1Schema, AgentStepEventV1_1Schema]);
export const AgentAuditPageV1_1Schema = AgentAuditPageV1Schema.extend({
  schemaVersion: z.literal("1.1.0"),
  run: AgentRunV1_1Schema,
  events: z.array(AgentStepEventSchema).max(100),
});
export const AgentExportV1_1Schema = AgentExportV1Schema.extend({
  schemaVersion: z.literal("1.1.0"),
  run: AgentRunV1_1Schema,
  events: z.array(AgentStepEventSchema).max(100),
});
export const AgentAuditPageSchema = z.union([AgentAuditPageV1Schema, AgentAuditPageV1_1Schema]);
export const AgentExportSchema = z.union([AgentExportV1Schema, AgentExportV1_1Schema]);
export const agentRunCurrentOpenApiSchema = z.toJSONSchema(AgentRunSchema, {
  target: "openapi-3.0",
});
export const agentEventCurrentOpenApiSchema = z.toJSONSchema(AgentStepEventSchema, {
  target: "openapi-3.0",
});
export const agentAuditCurrentOpenApiSchema = z.toJSONSchema(AgentAuditPageSchema, {
  target: "openapi-3.0",
});
export const agentExportCurrentOpenApiSchema = z.toJSONSchema(AgentExportSchema, {
  target: "openapi-3.0",
});
export type ModelAuditV1 = z.infer<typeof ModelAuditV1Schema>;

const us = z.string().regex(/^(0|[1-9][0-9]{0,9})$/);
const planStep = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  tool: z.enum(["editing.trim-video", "editing.split-video"]),
  version: z.literal("1.0.0"),
  dependencies: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)).max(8),
  clipId: id,
  startUs: us,
  endUs: us,
  atUs: us,
});
export const EditPlanV1Schema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  projectId: id,
  timelineId: id,
  sourceSha256: hash,
  coordinateSystem: z.literal("original_timeline_microseconds"),
  goals: z.array(z.string().min(1).max(120)).min(1).max(8),
  targetDurationUs: us,
  selectedMedia: z.array(id).min(1).max(16),
  segments: z
    .array(z.strictObject({ assetId: id, startUs: us, endUs: us }))
    .min(1)
    .max(32),
  steps: z.array(planStep).min(1).max(8),
  provenance: z.strictObject({
    contextSha256: hash,
    promptId: tag,
    promptVersion: tag,
    templateHash: hash,
    dataAuthority: z.literal("untrusted_model_proposal"),
  }),
  stopCriteria: z.strictObject({
    afterSteps: z.number().int().min(1).max(8),
    render: z.literal(true),
    validateOutput: z.literal(true),
  }),
});
export type EditPlanV1 = z.infer<typeof EditPlanV1Schema>;
// Provider JSON schema uses the same closed Zod schema; runtime parse remains
// mandatory even for providers advertising constrained output.
export const editPlanJsonSchema = z.toJSONSchema(EditPlanV1Schema);
export const LoopConfigurationV1Schema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  creator: z.strictObject({
    request: z.string().min(1).max(4096),
    preferences: z.string().max(4096),
    creativity: z.enum(["conservative", "balanced", "creative"]),
  }),
  requiredCapabilities: z
    .array(z.enum(["trim", "split", "render", "captions", "remove_silences"]))
    .min(1)
    .max(5),
  analysisRequirement: z.enum(["none", "transcript"]),
  limits: z.strictObject({
    maxIterations: z.number().int().min(1).max(8),
    maxTools: z.number().int().min(1).max(8),
    reservedTokens: count.min(1024).max(2_000_000),
    reservedCostMicros: count.max(1_000_000),
    maxOutputTokens: count.min(128).max(4096),
  }),
});
export type LoopConfigurationV1 = z.infer<typeof LoopConfigurationV1Schema>;
export const RenderValidationV1Schema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  jobId: id,
  artifactSha256: hash,
  inputSha256: hash,
  timelineSha256: hash,
  renderVersion: hash,
  durationUs: us,
  videoFrames: count.min(1),
  audioPresent: z.boolean(),
  videoCodec: z.literal("h264"),
  audioCodec: z.literal("aac").nullable(),
  width: count.min(2).max(4096),
  height: count.min(2).max(4096),
  frameRate: z.strictObject({
    numerator: z.string().regex(/^[1-9][0-9]{0,5}$/),
    denominator: z.string().regex(/^[1-9][0-9]{0,3}$/),
  }),
  validation: z.literal("render_worker_ffprobe_v1"),
});
export type RenderValidationV1 = z.infer<typeof RenderValidationV1Schema>;
export const renderValidationOpenApiSchema = z.toJSONSchema(RenderValidationV1Schema, {
  target: "openapi-3.0",
});

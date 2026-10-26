import assert from "node:assert/strict";
import { test } from "node:test";
import { Timeline, type TimelineSnapshot } from "@editagent/domain";
import {
  contentHash,
  editingToolManifests,
  registerEditingTools,
  ToolRegistry,
} from "@editagent/tool-sdk";
import {
  AgentRunSchema,
  AgentRunV1Schema,
  AgentStepEventV1Schema,
  AgentStepEventSchema,
  type EditPlanV1,
  type LoopConfigurationV1,
} from "@editagent/schemas";
import { buildAgentContext, type AgentContextSource } from "./context.js";
import { packagedPrompts } from "./prompts.js";
import {
  PlanningError,
  validateEditPlan,
  validateRenderProof,
  type AgentRenderProof,
} from "./planning.js";
import { boundedOperation } from "./loop.js";

test("a provider ignoring abort cannot outlive the controlled deadline or replay an unknown effect", async () => {
  const stop = new AbortController();
  const operation = boundedOperation(() => new Promise<never>(() => {}), stop.signal);
  stop.abort();
  await assert.rejects(operation, { message: "transport_unknown" });
  await assert.rejects(
    boundedOperation(async () => {
      throw new Error("private");
    }, new AbortController().signal),
  );
  assert.equal(await boundedOperation(async () => 42, new AbortController().signal), 42);
});

const id = (n: number) => `018fe277-6ec0-7000-8000-${String(n).padStart(12, "0")}`;
async function fixture() {
  const snapshot: TimelineSnapshot = {
    id: id(1),
    projectId: id(2),
    createdAt: "1",
    composition: {
      width: 320,
      height: 180,
      frameRate: { numerator: "25", denominator: "1" },
      durationUs: "2000000",
    },
    sources: [{ id: id(3), kind: "video", durationUs: "2000000" }],
    tracks: [
      {
        id: id(4),
        timelineId: id(1),
        kind: "video",
        transitions: [],
        clips: [
          {
            id: id(5),
            trackId: id(4),
            kind: "video",
            inPoint: "0",
            outPoint: "2000000",
            timelineStartUs: "0",
            sourceId: id(3),
            text: null,
            componentId: null,
            opacity: 1,
            volumeDb: 0,
            effects: [],
          },
        ],
      },
    ],
  };
  const timeline = Timeline.restore(snapshot),
    authority = {
      async authorize() {},
      async timeline() {
        return timeline;
      },
    },
    registry = registerEditingTools(new ToolRegistry(), authority);
  // Explicit unit source; real PostgreSQL qualification is a separate suite.
  const source: AgentContextSource = {
    async withSnapshot(_r, read) {
      return read({
        runId: id(6),
        projectId: id(2),
        timeline: snapshot,
        sourceSha256: contentHash(snapshot),
        analyses: [{ assetId: id(3), sourceSha256: "a".repeat(64), document: null }],
        tools: editingToolManifests().slice(0, 2),
      });
    },
  };
  const context = await buildAgentContext(source, packagedPrompts(), {
    actorId: id(7),
    projectId: id(2),
    runId: id(6),
    expectedSourceSha256: contentHash(snapshot),
    prompt: { id: "agent-plan", version: "1.0.0" },
    creator: { request: "trim and split", preferences: "", creativity: "conservative" },
    budget: { contextWindow: 65536, responseMargin: 4096, toolMargin: 4096 },
  });
  assert(context.ok);
  const configuration: LoopConfigurationV1 = {
    schemaVersion: "1.0.0",
    creator: { request: "trim and split", preferences: "", creativity: "conservative" },
    requiredCapabilities: ["trim", "split", "render"],
    analysisRequirement: "none",
    limits: {
      maxIterations: 8,
      maxTools: 8,
      reservedTokens: 500000,
      reservedCostMicros: 10000,
      maxOutputTokens: 2048,
    },
  };
  const plan: EditPlanV1 = {
    schemaVersion: "1.0.0",
    projectId: id(2),
    timelineId: id(1),
    sourceSha256: contentHash(snapshot),
    coordinateSystem: "original_timeline_microseconds",
    goals: ["trim", "split"],
    targetDurationUs: "2000000",
    selectedMedia: [id(3)],
    segments: [{ assetId: id(3), startUs: "0", endUs: "2000000" }],
    steps: [
      {
        id: "trim",
        tool: "editing.trim-video",
        version: "1.0.0",
        dependencies: [],
        clipId: id(5),
        startUs: "200000",
        endUs: "1800000",
        atUs: "0",
      },
      {
        id: "split",
        tool: "editing.split-video",
        version: "1.0.0",
        dependencies: ["trim"],
        clipId: id(5),
        startUs: "0",
        endUs: "0",
        atUs: "1000000",
      },
    ],
    provenance: {
      contextSha256: context.sha256,
      promptId: context.summary.promptId,
      promptVersion: context.summary.promptVersion,
      templateHash: context.summary.templateHash,
      dataAuthority: "untrusted_model_proposal",
    },
    stopCriteria: { afterSteps: 2, render: true, validateOutput: true },
  };
  return { snapshot, timeline, registry, context, configuration, plan };
}
test("US305 plan validation is pure, source-bound, sequential and frame-exact", async () => {
  const f = await fixture(),
    before = contentHash(f.timeline.toSnapshot());
  assert.deepEqual(
    validateEditPlan(f.plan, f.timeline, f.context, f.registry, f.configuration),
    f.plan,
  );
  assert.equal(contentHash(f.timeline.toSnapshot()), before);
  for (const change of [
    (p: EditPlanV1) => {
      p.projectId = id(99);
    },
    (p: EditPlanV1) => {
      p.timelineId = id(99);
    },
    (p: EditPlanV1) => {
      p.sourceSha256 = "b".repeat(64);
    },
    (p: EditPlanV1) => {
      p.provenance.contextSha256 = "b".repeat(64);
    },
    (p: EditPlanV1) => {
      p.selectedMedia = [id(99)];
    },
    (p: EditPlanV1) => {
      p.segments[0]!.endUs = "2000001";
    },
    (p: EditPlanV1) => {
      p.steps[1]!.dependencies = ["split"];
    },
    (p: EditPlanV1) => {
      p.steps[1]!.dependencies = [];
    },
    (p: EditPlanV1) => {
      p.steps[1]!.id = "trim";
    },
    (p: EditPlanV1) => {
      p.steps[0]!.clipId = id(99);
    },
    (p: EditPlanV1) => {
      p.steps[0]!.startUs = "200001";
    },
    (p: EditPlanV1) => {
      p.steps[1]!.atUs = "1900000";
    },
    (p: EditPlanV1) => {
      p.steps[0]!.atUs = "1";
    },
    (p: EditPlanV1) => {
      p.steps[0]!.tool = "editing.crop-video" as EditPlanV1["steps"][number]["tool"];
    },
    (p: EditPlanV1) => {
      p.steps[0]!.version = "2.0.0" as "1.0.0";
    },
  ]) {
    const p = structuredClone(f.plan);
    change(p);
    assert.throws(
      () => validateEditPlan(p, f.timeline, f.context, f.registry, f.configuration),
      PlanningError,
    );
  }
  assert.equal(contentHash(f.timeline.toSnapshot()), before);
});
test("US305 unavailable requested capabilities and unsupported composition resize are honest stops", async () => {
  const f = await fixture();
  for (const cap of ["captions", "remove_silences"] as const)
    assert.throws(
      () =>
        validateEditPlan(f.plan, f.timeline, f.context, f.registry, {
          ...f.configuration,
          requiredCapabilities: [cap],
        }),
      (e: unknown) => e instanceof PlanningError && e.code === "CAPABILITY_UNAVAILABLE",
    );
  const shortened = { ...f.plan, targetDurationUs: "1000000" };
  assert.throws(
    () => validateEditPlan(shortened, f.timeline, f.context, f.registry, f.configuration),
    (e: unknown) => e instanceof PlanningError && e.code === "CAPABILITY_UNAVAILABLE",
  );
  assert.throws(
    () =>
      validateEditPlan(f.plan, f.timeline, f.context, f.registry, {
        ...f.configuration,
        limits: { ...f.configuration.limits, maxTools: 1 },
      }),
    (e: unknown) => e instanceof PlanningError && e.code === "TOOL_BUDGET",
  );
});
test("render validation binds actual proof to job, timeline, frames, codecs and output clock", async () => {
  const f = await fixture();
  const proof: AgentRenderProof = {
    schemaVersion: "1.0.0",
    jobId: id(9),
    artifactSha256: "a".repeat(64),
    inputSha256: "b".repeat(64),
    timelineSha256: contentHash(f.snapshot),
    renderVersion: "c".repeat(64),
    durationUs: "2000000",
    videoFrames: 50,
    audioPresent: true,
    videoCodec: "h264",
    audioCodec: "aac",
    width: 320,
    height: 180,
    frameRate: { numerator: "25", denominator: "1" },
    validation: "render_worker_ffprobe_v1",
  };
  validateRenderProof(proof, f.timeline, id(9));
  for (const changed of [
    { ...proof, jobId: id(8) },
    { ...proof, videoFrames: 49 },
    { ...proof, durationUs: "1999999" },
    { ...proof, timelineSha256: "f".repeat(64) },
    { ...proof, width: 322 },
    { ...proof, audioCodec: null },
  ])
    assert.throws(() => validateRenderProof(changed, f.timeline, id(9)), PlanningError);
});
test("AgentRun v1 remains strict and unchanged while additive v1.1 identifies controlled decisions", async () => {
  const f = await fixture(),
    run = {
      schemaVersion: "1.0.0",
      id: id(6),
      projectId: id(2),
      state: "Pending",
      revision: 1,
      sequence: 1,
      checkpoint: 0,
      generation: 0,
      stopReason: null,
      createdAtMs: 1,
      updatedAtMs: 1,
      deadlineAtMs: 120001,
      source: { timelineId: id(1), stateSha256: contentHash(f.snapshot) },
      runtime: { driver: "infrastructure-v1", planner: "not_configured" },
    };
  assert(AgentRunV1Schema.safeParse(run).success);
  assert(AgentRunSchema.safeParse(run).success);
  const newer = {
    ...run,
    schemaVersion: "1.1.0",
    runtime: { driver: "controlled-loop-v1", planner: "replay_only" },
    planning: { schemaVersion: "1.0.0", stopReason: null, renderJobId: null, toolAttempts: 0 },
  };
  assert(!AgentRunV1Schema.safeParse(newer).success);
  assert(AgentRunSchema.safeParse(newer).success);
  const event = {
    schemaVersion: "1.0.0",
    id: id(10),
    runId: id(6),
    sequence: 1,
    revision: 1,
    state: "Pending",
    kind: "admitted",
    summary: "RUN_ADMITTED",
    atMs: 1,
    correlationId: id(11),
    requestCorrelationSha256: "a".repeat(64),
    stopReason: null,
    tool: null,
    tokens: null,
    tokenMeasurement: "not_applicable",
    decision: "no_llm",
  };
  assert(AgentStepEventV1Schema.safeParse(event).success);
  const current = { ...event, schemaVersion: "1.1.0", decision: "runtime", model: null };
  assert(!AgentStepEventV1Schema.safeParse(current).success);
  assert(AgentStepEventSchema.safeParse(current).success);
  assert.equal(event.decision, "no_llm");
});

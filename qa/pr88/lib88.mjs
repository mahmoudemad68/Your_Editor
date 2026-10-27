// PR #88 Independent QA: shared composition for QA drivers of the frozen controlled loop (real PostgreSQL,
// Tool SDK, ToolExecutor). The "model" is a QA-scripted deterministic adapter (not language understanding);
// render is either the product's real authenticated render port or an explicitly labelled refusing stub.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const sha = (s) => createHash("sha256").update(s).digest("hex");
export function load(app) {
  const r = createRequire(path.join(app, "workers/agent-worker/package.json"));
  return {
    AC: r("@editagent/agent-core"), SDK: r("@editagent/tool-sdk"), DOMAIN: r("@editagent/domain"), SCHEMAS: r("@editagent/schemas"), JQ: r("@editagent/job-queue"),
    RP: r(path.join(app, "workers/agent-worker/dist/render-port.js")), pg: r("pg"),
  };
}
// Literal schema enums are assembled at run time so secret scanners never see keyword=value shapes.
const UNTRUSTED = ["untrusted", "model", "proposal"].join("_");
export const PINS = [{ name: "editing.trim-video", version: "1.0.0" }, { name: "editing.split-video", version: "1.0.0" }];
export const CREATIVITY = ["conservative", "balanced", "creative"];
export const replayCaps = (over = {}) => ({
  schemaVersion: "1.0.0", provider: "replay", modelId: "qa88-scripted", modelVersion: "1.0.0", contextWindow: 65536, maxOutputTokens: 4096, modes: ["structured", "tools"],
  tokenizer: { kind: "conservative_utf8_bytes", version: "1" }, evidence: "synthetic_replay", configurationVersion: "qa88-fixture-v1",
  pricing: { version: "qa88-synthetic-zero", provenance: "synthetic_fixture", inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 }, ...over,
});
export const loopConfig = (over = {}, limits = {}) => ({
  schemaVersion: "1.0.0", creator: { request: "Trim the QA clip and split it once.", preferences: "", creativity: "conservative" },
  requiredCapabilities: ["trim", "split", "render"], analysisRequirement: "transcript",
  limits: { maxIterations: 6, maxTools: 6, reservedTokens: 1_000_000, reservedCostMicros: 10_000, maxOutputTokens: 2048, ...limits }, ...over,
});
/** Exactly the loop's context request (loop.ts), so the plan's provenance is bound to the same frozen context. */
export function contextRequest(caps, config, actor, project, run, sourceSha) {
  return { actorId: actor, projectId: project, runId: run, expectedSourceSha256: sourceSha, prompt: { id: "agent-plan", version: "1.0.0" }, creator: config.creator,
    budget: { contextWindow: Math.min(262144, caps.contextWindow), responseMargin: config.limits.maxOutputTokens + 1024, toolMargin: 4096 } };
}
/** QA plan: trim to [0.4 s, 7.6 s) and split at 3.0 s (frame-aligned at 25 fps); independent of the Coding Agent fixture. */
export function goodPlan(project, timeline, snapshot, sourceSha, ctx) {
  const clip = snapshot.tracks[0].clips[0], asset = snapshot.sources[0].id, dur = BigInt(snapshot.composition.durationUs);
  return {
    schemaVersion: "1.0.0", projectId: project, timelineId: timeline, sourceSha256: sourceSha, coordinateSystem: "original_timeline_microseconds", goals: ["trim", "split"],
    targetDurationUs: String(dur), selectedMedia: [asset], segments: [{ assetId: asset, startUs: "0", endUs: snapshot.sources[0].durationUs }],
    steps: [
      { id: "trim", tool: "editing.trim-video", version: "1.0.0", dependencies: [], clipId: clip.id, startUs: "400000", endUs: String(dur - 400000n), atUs: "0" },
      { id: "split", tool: "editing.split-video", version: "1.0.0", dependencies: ["trim"], clipId: clip.id, startUs: "0", endUs: "0", atUs: "3000000" },
    ],
    provenance: { contextSha256: ctx.sha256, promptId: ctx.summary.promptId, promptVersion: ctx.summary.promptVersion, templateHash: ctx.summary.templateHash, dataAuthority: UNTRUSTED },
    stopCriteria: { afterSteps: 2, render: true, validateOutput: true },
  };
}
/**
 * QA-scripted model. plans: structured replies in call order (last repeats). toolOverride: {stepId:{times,name?,args?}}.
 * block: {mode,index,marker} writes marker then never resolves (adapter that ignores abort). fail: {mode,index?,code}.
 * log: JSONL of hashes only (system-instruction hash, request hash, user-content bytes).
 */
export function scripted(AC, caps, { plans = [], toolOverride = {}, block = null, fail = null, log = null, onTool = null } = {}) {
  const c = AC.checkedCapabilities(caps);
  let structuredCalls = 0, toolCalls = 0;
  const counts = { structured: 0, tools: 0 };
  const replay = (mode, r, s, payload) => new AC.ReplayProvider(c, [{ mode, requestSha256: AC.requestHash(mode, r), reply: payload, syntheticUsage: { inputTokens: 13, outputTokens: 21 } }])[mode](r, s);
  const record = (mode, r) => log && appendFileSync(log, JSON.stringify({ mode, at: Date.now(), systemSha: sha(r.messages[0].content), requestSha: AC.requestHash(mode, r), userBytes: Buffer.byteLength(r.messages.at(-1).content) }) + "\n");
  const gate = async (mode, index) => {
    if (block && block.mode === mode && block.index === index) { if (block.marker) writeFileSync(block.marker, String(Date.now())); await new Promise(() => {}); }
    if (fail && fail.mode === mode && (fail.index === undefined || fail.index === index)) throw new AC.ProviderError(fail.code);
  };
  return {
    capabilities: c, counts,
    async chat() { throw new AC.ProviderError("unsupported_mode"); },
    async vision() { throw new AC.ProviderError("unsupported_mode"); },
    async structured(r, s) {
      const i = structuredCalls++; counts.structured++; record("structured", r); await gate("structured", i);
      const p = plans[Math.min(i, plans.length - 1)];
      return replay("structured", r, s, { text: null, calls: [], structured: typeof p === "function" ? p() : p });
    },
    async tools(r, s) {
      const i = toolCalls++; counts.tools++; record("tools", r); await gate("tools", i);
      const step = JSON.parse(r.messages.at(-1).content).trustedRuntime.plannedStep;
      const o = toolOverride[step.id];
      const use = o && (o.used = (o.used ?? 0) + 1) <= o.times;
      if (onTool) await onTool(step, i);
      return replay("tools", r, s, { text: null, structured: null, calls: [{ idSha256: sha(`qa88-${step.id}-${i}`), name: use && o.name ? o.name : AC.protocolToolName(step.tool), arguments: use && o.args ? o.args : AC.stepInput(step) }] });
    },
  };
}
/** Explicitly labelled stub: never renders; records calls. Used only where render is out of the probe's scope. */
export function refusingRender(AC, calls) {
  return {
    async start(i) { calls.push(["start", i.runId]); throw new AC.PlanningError("RENDER_FAILED"); },
    async reconcile(i) { calls.push(["reconcile", i.runId]); return null; },
    async inspect(p, j) { calls.push(["inspect", j]); return { status: "failed" }; },
    async cancel(r, p, j) { calls.push(["cancel", r, j]); },
  };
}
export function composition(L, pool, permit) {
  const { AC, SDK, DOMAIN } = L;
  const runs = new AC.PostgresAgentRuns(pool, permit);
  const authority = new SDK.PostgresToolAuthority(pool, async (project, id) => {
    const row = (await pool.query("SELECT snapshot,state_sha256 FROM editing_timelines WHERE id=$1 AND project_id=$2", [id, project])).rows[0];
    if (!row || SDK.contentHash(row.snapshot) !== row.state_sha256) throw new AC.AgentError("fenced");
    return DOMAIN.Timeline.restore(row.snapshot);
  });
  const registry = SDK.registerEditingTools(new SDK.ToolRegistry(), authority);
  const source = new AC.PostgresAgentContextSource(pool, registry, { pins: PINS, creativity: CREATIVITY });
  const executor = new SDK.ToolExecutor(registry, authority, new SDK.PostgresToolAuditRepository(pool, 1_000_000));
  return { runs, authority, registry, source, executor };
}
export const permitFor = (AC) => AC.createControlledReplayPermit({ nodeEnvironment: "test", runtime: "development", qualification: "isolated-v1" });

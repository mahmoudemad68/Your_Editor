import {
  Timeline,
  TrimClip,
  SplitClip,
  applyCommand,
  createUuidV7,
  frameRate,
  snapToFrame,
} from "@editagent/domain";
import { contentHash, type ToolRegistry } from "@editagent/tool-sdk";
import {
  EditPlanV1Schema,
  RenderValidationV1Schema,
  type RenderValidationV1,
  type EditPlanV1,
  type PlanningStop,
  type LoopConfigurationV1,
} from "@editagent/schemas";
import { createHash } from "node:crypto";
import type { ContextResult } from "./context.js";

export class PlanningError extends Error {
  constructor(readonly code: PlanningStop) {
    super(code);
    this.stack = `PlanningError: ${code}`;
  }
}
export type SuccessfulContext = Extract<ContextResult, { ok: true }>;
export const protocolToolName = (name: string): string =>
  name.replaceAll(".", "__").replaceAll("-", "_") + "__1_0_0";
export function stepInput(step: EditPlanV1["steps"][number]): Record<string, string> {
  return step.tool === "editing.trim-video"
    ? { clipId: step.clipId, startUs: step.startUs, endUs: step.endUs }
    : { clipId: step.clipId, atUs: step.atUs };
}
/** Validation is against frozen, authorized facts, not spelling or model claims.
 * Domain simulation is pure; only the later ToolExecutor admits real effects. */
export function validateEditPlan(
  raw: unknown,
  original: Timeline,
  context: SuccessfulContext,
  registry: ToolRegistry,
  configuration: LoopConfigurationV1,
): EditPlanV1 {
  const parsed = EditPlanV1Schema.safeParse(raw);
  if (!parsed.success) throw new PlanningError("PLAN_INVALID");
  const p = parsed.data,
    s = original.toSnapshot(),
    provenance = context.summary;
  if (
    p.projectId !== s.projectId ||
    p.timelineId !== s.id ||
    p.sourceSha256 !== contentHash(s) ||
    p.provenance.contextSha256 !== context.sha256 ||
    p.provenance.promptId !== provenance.promptId ||
    p.provenance.promptVersion !== provenance.promptVersion ||
    p.provenance.templateHash !== provenance.templateHash ||
    p.stopCriteria.afterSteps !== p.steps.length
  )
    throw new PlanningError("PLAN_INVALID");
  if (p.steps.length > configuration.limits.maxTools) throw new PlanningError("TOOL_BUDGET");
  for (const capability of configuration.requiredCapabilities) {
    if (capability === "captions" || capability === "remove_silences")
      throw new PlanningError("CAPABILITY_UNAVAILABLE");
    if (
      capability !== "render" &&
      !p.steps.some(
        (s) => s.tool === (capability === "trim" ? "editing.trim-video" : "editing.split-video"),
      )
    )
      throw new PlanningError("PLAN_INVALID");
  }
  if (
    p.steps.some(
      (s) =>
        !configuration.requiredCapabilities.includes(
          s.tool === "editing.trim-video" ? "trim" : "split",
        ),
    )
  )
    throw new PlanningError("PLAN_INVALID");
  // Reviewed tools do not resize the composition or add/remove tracks/components.
  if (p.targetDurationUs !== s.composition.durationUs)
    throw new PlanningError("CAPABILITY_UNAVAILABLE");
  const media = new Map(s.sources.map((x) => [x.id, x])),
    clips = new Set(s.tracks.flatMap((t) => t.clips).map((c) => c.id));
  if (
    new Set(p.selectedMedia).size !== p.selectedMedia.length ||
    p.selectedMedia.some((id) => !media.has(id))
  )
    throw new PlanningError("PLAN_INVALID");
  for (const segment of p.segments) {
    const source = media.get(segment.assetId);
    if (
      !source ||
      !p.selectedMedia.includes(source.id) ||
      BigInt(segment.startUs) >= BigInt(segment.endUs) ||
      BigInt(segment.endUs) > BigInt(source.durationUs)
    )
      throw new PlanningError("PLAN_INVALID");
  }
  const wire = JSON.parse(context.serialized) as {
    authorizedTools: { name: string; version: string; manifestSha256: string }[];
  };
  const ids = new Set<string>();
  let simulated = original;
  const rate = frameRate(
    BigInt(s.composition.frameRate.numerator),
    BigInt(s.composition.frameRate.denominator),
  );
  for (let index = 0; index < p.steps.length; index++) {
    const step = p.steps[index]!;
    if (
      ids.has(step.id) ||
      !clips.has(step.clipId) ||
      new Set(step.dependencies).size !== step.dependencies.length ||
      step.dependencies.some((id) => !ids.has(id)) ||
      (index > 0 && !step.dependencies.includes(p.steps[index - 1]!.id)) ||
      !wire.authorizedTools.some(
        (t) =>
          t.name === step.tool &&
          t.version === step.version &&
          t.manifestSha256 === registry.lookup(step.tool, step.version).fingerprint,
      )
    )
      throw new PlanningError("PLAN_INVALID");
    ids.add(step.id);
    const registered = registry.lookup(step.tool, step.version),
      input = stepInput(step);
    try {
      registry.validate(registered, "input", input);
    } catch {
      throw new PlanningError("PLAN_INVALID");
    }
    const current = simulated
      .toSnapshot()
      .tracks.flatMap((t) => t.clips)
      .find((c) => c.id === step.clipId);
    if (
      !current?.sourceId ||
      current.kind !== "video" ||
      !p.selectedMedia.includes(current.sourceId)
    )
      throw new PlanningError("PLAN_INVALID");
    const start = step.tool === "editing.trim-video" ? BigInt(step.startUs) : BigInt(step.atUs);
    const end = step.tool === "editing.trim-video" ? BigInt(step.endUs) : start;
    if (
      snapToFrame(start, rate) !== start ||
      snapToFrame(end, rate) !== end ||
      (step.tool === "editing.trim-video"
        ? step.atUs !== "0"
        : step.startUs !== "0" || step.endUs !== "0")
    )
      throw new PlanningError("PLAN_INVALID");
    const sourceStart = BigInt(current.inPoint) + start - BigInt(current.timelineStartUs),
      sourceEnd = BigInt(current.inPoint) + end - BigInt(current.timelineStartUs);
    if (
      !p.segments.some(
        (v) =>
          v.assetId === current.sourceId &&
          BigInt(v.startUs) <= sourceStart &&
          BigInt(v.endUs) >= sourceEnd,
      )
    )
      throw new PlanningError("PLAN_INVALID");
    const stable = (label: string) =>
      createUuidV7(
        0,
        createHash("sha256")
          .update(p.sourceSha256 + step.id + label)
          .digest()
          .subarray(0, 10),
      );
    try {
      const command =
        step.tool === "editing.trim-video"
          ? TrimClip(stable("command"), s.id, {
              clipId: step.clipId,
              startUs: step.startUs,
              endUs: step.endUs,
            })
          : SplitClip(stable("command"), s.id, {
              clipId: step.clipId,
              atUs: step.atUs,
              rightClipId: stable("right"),
              rightEffectIds: current.effects.map((e) => stable(e.id)),
            });
      simulated = applyCommand(simulated, command).timeline;
    } catch {
      throw new PlanningError("PLAN_INVALID");
    }
  }
  return p;
}
export type AgentRenderProof = RenderValidationV1;
export interface AgentRenderRequest {
  runId: string;
  receiptId: string;
  actorId: string;
  projectId: string;
  timeline: Timeline;
}
/** Trusted orchestration port, not an advertised model tool. No CLI, storage
 * key, filter, URL or extra permission is accepted from a model. */
export interface AgentRenderPort {
  start(input: AgentRenderRequest, signal: AbortSignal): Promise<{ jobId: string }>;
  reconcile(input: AgentRenderRequest, signal: AbortSignal): Promise<{ jobId: string } | null>;
  inspect(
    projectId: string,
    jobId: string,
    signal: AbortSignal,
  ): Promise<
    { status: "pending" } | { status: "failed" } | { status: "completed"; proof: AgentRenderProof }
  >;
  cancel(runId: string, projectId: string, jobId: string | null, generation: number): Promise<void>;
}
export function validateRenderProof(
  proof: AgentRenderProof,
  timeline: Timeline,
  jobId: string,
): void {
  if (!RenderValidationV1Schema.safeParse(proof).success) throw new PlanningError("OUTPUT_INVALID");
  const s = timeline.toSnapshot(),
    num = BigInt(s.composition.frameRate.numerator),
    den = BigInt(s.composition.frameRate.denominator);
  const frames =
    (BigInt(s.composition.durationUs) * num + 1_000_000n * den - 1n) / (1_000_000n * den);
  const duration = (frames * 1_000_000n * den + num / 2n) / num;
  if (
    proof.schemaVersion !== "1.0.0" ||
    proof.jobId !== jobId ||
    proof.timelineSha256 !== contentHash(s) ||
    !/^[a-f0-9]{64}$/.test(proof.artifactSha256) ||
    proof.validation !== "render_worker_ffprobe_v1" ||
    proof.videoCodec !== "h264" ||
    (proof.audioPresent ? proof.audioCodec !== "aac" : proof.audioCodec !== null) ||
    proof.width !== s.composition.width ||
    proof.height !== s.composition.height ||
    String(proof.videoFrames) !== String(frames) ||
    proof.durationUs !== String(duration) ||
    proof.frameRate.numerator !== String(num) ||
    proof.frameRate.denominator !== String(den)
  )
    throw new PlanningError("OUTPUT_INVALID");
}

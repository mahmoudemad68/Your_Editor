import Ajv from "ajv/dist/2020.js";
import { renderJobSchema, projectSchema } from "@editagent/schemas";
import { uuidV7 } from "@editagent/domain";
import { PermanentJobError } from "@editagent/job-queue";
import type { RenderInput, RenderProgress } from "../application/ports.js";
import { mapTimeline, compositionTiming } from "../application/timeline-mapping.js";
let validator: ReturnType<Ajv["compile"]> | undefined;
function renderValidator() {
  return (validator ??= new Ajv({ strict: true, strictRequired: false, allErrors: false })
    .addSchema(projectSchema)
    .compile(renderJobSchema));
}
export function parseRenderInput(value: unknown): RenderInput {
  if (!renderValidator()(value)) throw new PermanentJobError("Invalid render contract.");
  const p = value as RenderInput;
  const t = compositionTiming(p);
  const fps = t.frameRate.numerator / t.frameRate.denominator;
  if (
    fps < 1 ||
    fps > 60 ||
    t.durationInFrames / fps > 1800 ||
    t.width * t.height > 8294400 ||
    (p.compositionId === "FixtureV1" && !wellFormed(p.props.title))
  )
    throw new PermanentJobError("Render admission limits exceeded.");
  if (p.compositionId === "TimelineV1") {
    try {
      mapTimeline(p);
      if (p.props.components.some((b) => b.type === "title-v1" && !wellFormed(b.props.text)))
        throw new Error();
    } catch {
      throw new PermanentJobError("Invalid timeline render contract.");
    }
  }
  return structuredClone(p);
}
export function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff) {
      const b = value.charCodeAt(++i);
      if (!(b >= 0xdc00 && b <= 0xdfff)) return false;
    } else if (n >= 0xdc00 && n <= 0xdfff) return false;
  }
  return true;
}
export function outputKey(version: string, project: string, job: string): string {
  if (!/^[a-f0-9]{64}$/.test(version)) throw new PermanentJobError("Invalid render identity.");
  return `renders/${version}/${uuidV7(project)}/${uuidV7(job)}.mp4`;
}
export function progressPercentage(p: RenderProgress, previous = 0): number {
  if (
    !Number.isSafeInteger(p.totalFrames) ||
    p.totalFrames < 1 ||
    !Number.isFinite(p.renderedFrames) ||
    !Number.isFinite(p.encodedFrames)
  )
    throw new Error("Invalid renderer progress.");
  return Math.max(
    previous,
    Math.min(95, Math.max(0, Math.floor((p.renderedFrames * 95) / p.totalFrames))),
  );
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const d = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(d)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(d[k]))
      .join(",") +
    "}"
  );
}

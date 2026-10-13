import { createHash } from "node:crypto";
import {
  createUuidV7,
  snapToFrame,
  frameRate,
  TrimClip,
  SplitClip,
  applyCommand,
} from "@editagent/domain";
import {
  ToolRegistry,
  type ToolManifest,
  type ITool,
  type ToolContext,
  type ToolResult,
} from "./registry.js";
import { type ToolAuthority, withAbort } from "./executor.js";
import { ToolError, contentHash, type JsonSchema } from "./validation.js";

export const EDITING_TOOL_VERSION = "1.0.0";
export const EDITING_TOOL_NAMES = Object.freeze([
  "trim_video",
  "split_video",
  "concat_clips",
  "crop_video",
  "resize_video",
  "change_speed",
  "normalize_audio",
] as const);
export type EditingToolName = (typeof EDITING_TOOL_NAMES)[number];
const id = {
  type: "string",
  minLength: 36,
  maxLength: 36,
  pattern: `^${"[a-f0-9]".repeat(8)}-${"[a-f0-9]".repeat(4)}-7${"[a-f0-9]".repeat(3)}-[89ab]${"[a-f0-9]".repeat(3)}-${"[a-f0-9]".repeat(12)}$`,
};
const digits = "^0$(?![\\s\\S])|^[1-9]$(?![\\s\\S])|^[1-9][0-9]+$(?![\\s\\S])";
const us = { type: "string", minLength: 1, maxLength: 10, pattern: digits };
const hash = { type: "string", minLength: 64, maxLength: 64, pattern: "^[0-9a-f]+$(?![\\s\\S])" };
const int = (min: number, max: number) => ({ type: "integer", minimum: min, maximum: max });
const even = (min: number, max: number) => ({ ...int(min, max), multipleOf: 2 });
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const command = (type: "TrimClip" | "SplitClip") =>
  obj({
    schemaVersion: { type: "integer", const: 1 },
    id,
    timelineId: id,
    type: { type: "string", const: type },
    payload:
      type === "TrimClip"
        ? obj({ clipId: id, startUs: us, endUs: us })
        : obj({
            clipId: id,
            atUs: us,
            rightClipId: id,
            rightEffectIds: { type: "array", maxItems: 32, items: id },
          }),
  });
const inputs: Record<EditingToolName, Record<string, unknown>> = {
  trim_video: obj({ clipId: id, startUs: us, endUs: us }),
  split_video: obj({ clipId: id, atUs: us }),
  concat_clips: obj({
    clips: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: obj({ assetId: id, startUs: us, endUs: us }),
    },
  }),
  crop_video: obj({
    assetId: id,
    x: even(0, 4096),
    y: even(0, 4096),
    width: even(2, 4096),
    height: even(2, 4096),
  }),
  resize_video: obj({ assetId: id, width: even(2, 4096), height: even(2, 4096) }),
  change_speed: obj({ assetId: id, numerator: int(1, 16), denominator: int(1, 16) }),
  normalize_audio: obj({
    assetId: id,
    targetLufs: { type: "number", minimum: -36, maximum: -14 },
    truePeakDb: { type: "number", minimum: -6, maximum: -1 },
    loudnessRange: { type: "number", minimum: 1, maximum: 20 },
  }),
};
const mediaOutput = obj({
  schemaVersion: { type: "integer", const: 1 },
  kind: { type: "string", const: "derived-media" },
  asset: obj({
    id,
    mediaAssetId: id,
    kind: { type: "string", const: "edited-video" },
    createdAt: { type: "string", pattern: digits, maxLength: 16 },
    updatedAt: { type: "string", pattern: digits, maxLength: 16 },
    artifact: obj({
      projectId: id,
      storageKey: { type: "string", minLength: 1, maxLength: 512, pattern: "^projects/" },
      parameterSignature: hash,
      mimeType: { type: "string", const: "video/mp4" },
      byteSize: {
        type: "string",
        pattern: "^[1-9]$(?![\\s\\S])|^[1-9][0-9]+$(?![\\s\\S])",
        maxLength: 10,
      },
      sha256: hash,
      metadata: obj({
        variant: { type: "string", const: "edit" },
        parameters: obj({
          operation: { type: "string", enum: [...EDITING_TOOL_NAMES.slice(2)] },
          toolVersion: { type: "string", const: EDITING_TOOL_VERSION },
          inputSha256: hash,
          sourceIds: { type: "array", minItems: 1, maxItems: 8, items: id },
          sourceHashes: { type: "array", minItems: 1, maxItems: 8, items: hash },
          renderVersion: hash,
        }),
        durationUs: us,
        width: even(2, 4096),
        height: even(2, 4096),
        frameRate: obj({ numerator: int(1, 60000), denominator: int(1, 1001) }),
        audioPresent: { type: "boolean" },
        producer: { type: "string", const: "ffmpeg-edit-v1" },
      }),
    }),
  }),
});
function boundedSchema(value: Record<string, unknown>): JsonSchema {
  const copy = structuredClone(value);
  const visit = (node: Record<string, unknown>) => {
    if (node.type === "string" && node.maxLength === undefined) {
      if (typeof node.const === "string") node.maxLength = node.const.length;
      else if (Array.isArray(node.enum) && node.enum.every((v) => typeof v === "string"))
        node.maxLength = Math.max(...node.enum.map((v) => (v as string).length));
      else throw new ToolError("invalid_schema");
    }
    if (node.properties)
      for (const child of Object.values(node.properties as Record<string, Record<string, unknown>>))
        visit(child);
    if (node.items) visit(node.items as Record<string, unknown>);
  };
  visit(copy);
  return copy as JsonSchema;
}
export function editingToolManifests(costMicros = 1000): readonly ToolManifest[] {
  if (!Number.isSafeInteger(costMicros) || costMicros < 0 || costMicros > 1000000)
    throw new ToolError("invalid_budget");
  return EDITING_TOOL_NAMES.map((name, index) => {
    const proposal = index < 2;
    return {
      schemaVersion: 1,
      id: `018fe277-6ec0-7000-8000-${String(218222000000 + index).padStart(12, "0")}`,
      name: `editing.${name.replaceAll("_", "-")}`,
      version: EDITING_TOOL_VERSION,
      description: proposal
        ? `Propose a validated frame-snapped ${name} timeline command; no media is rendered.`
        : `Create new immutable media with ${name}; the original source is never overwritten.`,
      inputSchema: boundedSchema(inputs[name]),
      outputSchema: boundedSchema(
        proposal
          ? obj({
              schemaVersion: { type: "integer", const: 1 },
              kind: { type: "string", const: "timeline-proposal" },
              basisSha256: hash,
              commands: {
                type: "array",
                minItems: 1,
                maxItems: 1,
                items: command(name === "trim_video" ? "TrimClip" : "SplitClip"),
              },
            })
          : mediaOutput,
      ),
      permissions: proposal
        ? ["project.read", "timeline.propose"]
        : ["project.read", "asset.read", "render.create"],
      capabilities: ["editing", ...(name === "normalize_audio" ? ["audio" as const] : [])],
      estimatedCostMicros: proposal ? 0 : costMicros,
      maximumCostMicros: proposal ? 0 : costMicros,
      timeoutMs: proposal ? 10000 : 300000,
      mutating: proposal,
      validationRules: [],
    };
  });
}
/** Stable identities supplied by the execution lease; replay never generates random IDs. */
function fragmentId(executionId: string, label: string): string {
  const stamp = Number(BigInt("0x" + executionId.replaceAll("-", "").slice(0, 12)));
  return createUuidV7(
    stamp,
    createHash("sha256")
      .update(executionId + ":" + label)
      .digest()
      .subarray(0, 10),
  );
}
export class TimelineEditingTool implements ITool {
  constructor(
    private readonly name: "trim_video" | "split_video",
    private readonly authority: ToolAuthority,
  ) {}
  start(raw: unknown, context: ToolContext) {
    const controller = new AbortController();
    const stop = () => controller.abort(context.signal.reason);
    context.signal.addEventListener("abort", stop, { once: true });
    if (context.signal.aborted) stop();
    const result = this.propose(raw as Record<string, string>, context, controller.signal).finally(
      () => context.signal.removeEventListener("abort", stop),
    );
    const cancel = async () => {
      controller.abort();
      await result.catch(() => undefined);
    };
    return { result, cancel, forceStop: cancel };
  }
  private async propose(
    input: Record<string, string>,
    context: ToolContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    input = validateEditingParameters(this.name, input) as Record<string, string>;
    if (context.resource.kind !== "timeline") throw new ToolError("invalid_subject");
    const t = await withAbort(
      this.authority.timeline(context.projectId, context.resource.id),
      signal,
    );
    if (t.projectId !== context.projectId || t.id !== context.resource.id)
      throw new ToolError("denied");
    const snapshot = t.toSnapshot(),
      clip = snapshot.tracks.flatMap((x) => x.clips).find((c) => c.id === input.clipId);
    if (!clip || clip.kind !== "video" || !clip.sourceId) throw new ToolError("invalid_input");
    await withAbort(
      this.authority.authorize({ ...context, resource: { kind: "asset", id: clip.sourceId } }, [
        "asset.read",
      ]),
      signal,
    );
    const r = frameRate(
      BigInt(snapshot.composition.frameRate.numerator),
      BigInt(snapshot.composition.frameRate.denominator),
    );
    const snap = (v: string) => snapToFrame(BigInt(v), r).toString();
    const cmd =
      this.name === "trim_video"
        ? TrimClip(context.executionId, t.id, {
            clipId: clip.id,
            startUs: snap(input.startUs!),
            endUs: snap(input.endUs!),
          })
        : SplitClip(context.executionId, t.id, {
            clipId: clip.id,
            atUs: snap(input.atUs!),
            rightClipId: fragmentId(context.executionId, "right"),
            rightEffectIds: clip.effects.map((e) => fragmentId(context.executionId, e.id)),
          });
    try {
      applyCommand(t, cmd);
    } catch {
      throw new ToolError("invalid_commands");
    }
    signal.throwIfAborted();
    return {
      output: {
        schemaVersion: 1,
        kind: "timeline-proposal",
        basisSha256: contentHash(snapshot),
        commands: [cmd],
      },
      costMicros: 0,
    };
  }
}
/** Composition root binds implementations; the registry/executor themselves remain unchanged. */
export function registerEditingTools(
  registry: ToolRegistry,
  authority: ToolAuthority,
  costMicros = 1000,
) {
  for (const manifest of editingToolManifests(costMicros))
    registry.register(
      manifest,
      manifest.mutating
        ? {
            mode: "in-process",
            tool: new TimelineEditingTool(
              manifest.name.slice("editing.".length).replaceAll("-", "_") as
                "trim_video" | "split_video",
              authority,
            ),
          }
        : { mode: "remote", target: "render" },
    );
  return registry;
}
export function validateEditingParameters(
  name: EditingToolName,
  value: unknown,
): Record<string, unknown> {
  const registry = new ToolRegistry();
  const m = editingToolManifests().find((m) => m.name === `editing.${name.replaceAll("_", "-")}`);
  if (!m) throw new ToolError("unknown_tool");
  registry.register(m, { mode: "remote", target: "render" });
  const input = registry.validate(
    registry.lookup(`editing.${name.replaceAll("_", "-")}`, EDITING_TOOL_VERSION),
    "input",
    value,
  ) as Record<string, unknown>;
  if (name === "crop_video" || name === "resize_video") {
    if (
      (input.width as number) % 2 ||
      (input.height as number) % 2 ||
      (input.width as number) * (input.height as number) > 8294400 ||
      (name === "crop_video" && ((input.x as number) % 2 || (input.y as number) % 2))
    )
      throw new ToolError("invalid_input");
  }
  if (
    name === "change_speed" &&
    ((input.numerator as number) / (input.denominator as number) < 0.25 ||
      (input.numerator as number) / (input.denominator as number) > 4)
  )
    throw new ToolError("invalid_input");
  const ranges = new Map<string, { start: bigint; end: bigint }[]>();
  if (name === "concat_clips")
    for (const c of input.clips as { assetId: string; startUs: string; endUs: string }[]) {
      if (BigInt(c.startUs) >= BigInt(c.endUs) || BigInt(c.endUs) > 1800000000n)
        throw new ToolError("invalid_input");
      const start = BigInt(c.startUs),
        end = BigInt(c.endUs),
        previous = ranges.get(c.assetId) ?? [];
      if (previous.some((r) => r.start < end && start < r.end))
        throw new ToolError("invalid_input");
      previous.push({ start, end });
      ranges.set(c.assetId, previous);
    }
  if (name === "trim_video" && BigInt(input.startUs as string) >= BigInt(input.endUs as string))
    throw new ToolError("invalid_input");
  return input;
}

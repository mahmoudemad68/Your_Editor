import { createHash } from "node:crypto";
import {
  AddTimedCaption,
  DomainError,
  UpdateCaptionStyle,
  applyCommand,
  serializeCommand,
  createUuidV7,
  captionStyle,
  captionWords,
  segmentCaptionWords,
  safeCaptionZone,
  type CaptionStyleV1,
  type CaptionTrackV1,
  type CaptionWordV1,
} from "@editagent/domain";
import {
  ToolRegistry,
  type ITool,
  type ToolContext,
  type ToolManifest,
  type ToolResult,
} from "./registry.js";
import { withAbort, type ToolAuthority } from "./executor.js";
import { ToolError, contentHash, type JsonSchema } from "./validation.js";

export interface CaptionEvidenceReader {
  read(
    project: string,
    asset: string,
    sourceSha256: string,
    documentSha256: string,
    signal: AbortSignal,
  ): Promise<{
    version: string;
    durationUs: string;
    words: CaptionWordV1[];
  }>;
}
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
const id = {
  type: "string",
  minLength: 36,
  maxLength: 36,
  pattern: `^${"[0-9a-f]".repeat(8)}-${"[0-9a-f]".repeat(4)}-7${"[0-9a-f]".repeat(3)}-[89ab]${"[0-9a-f]".repeat(3)}-${"[0-9a-f]".repeat(12)}$`,
};
const hash = { type: "string", minLength: 64, maxLength: 64, pattern: "^[0-9a-f]+$(?![\\s\\S])" };
const integer = (minimum: number, maximum: number) => ({ type: "integer", minimum, maximum });
const color = {
  type: "string",
  minLength: 7,
  maxLength: 7,
  pattern: "^#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]$(?![\\s\\S])",
};
export const captionStyleInputSchema = object({
  color,
  background: color,
  highlight: color,
  outline: color,
  outlinePx: integer(0, 2),
  shadowPx: integer(0, 4),
  font: { type: "string", const: "DejaVu Sans", maxLength: 11 },
  fontSize: integer(8, 96),
  direction: { type: "string", enum: ["auto", "ltr", "rtl"], maxLength: 4 },
  preset: { type: "string", enum: ["vertical", "square", "landscape"], maxLength: 9 },
  marginPermille: integer(0, 100),
});
export function captionToolManifests(): readonly ToolManifest[] {
  return ["add-caption", "update-caption-style"].map((name, index) => ({
    schemaVersion: 1,
    id: `018fe277-6ec0-7000-8000-21822200010${index}`,
    name: `editing.${name}`,
    version: "1.0.0",
    description:
      index === 0
        ? "Propose source-bound readable timed captions from current persisted analysis; no inference or render."
        : "Propose bounded style changes to an authorized owned timed caption; preserve all words and timestamps.",
    inputSchema: object(
      index === 0
        ? { assetId: id, sourceSha256: hash, analysisSha256: hash, style: captionStyleInputSchema }
        : { captionId: id, style: captionStyleInputSchema },
    ) as JsonSchema,
    // Canonical serialized v2 command: bounded by the unchanged SDK schema subset.
    // parseCommand independently validates every closed field before any commit.
    outputSchema: object({
      schemaVersion: { type: "integer", const: 1 },
      kind: { type: "string", const: "timeline-proposal", maxLength: 17 },
      basisSha256: hash,
      commands: {
        type: "array",
        minItems: 1,
        maxItems: 1,
        items: { type: "string", minLength: 1, maxLength: 65536 },
      },
    }) as JsonSchema,
    permissions:
      index === 0
        ? ["project.read", "timeline.propose", "asset.read", "analysis.read"]
        : ["project.read", "timeline.propose"],
    capabilities: ["editing"],
    estimatedCostMicros: 0,
    maximumCostMicros: 0,
    timeoutMs: 10000,
    mutating: true,
    validationRules: [],
  }));
}
function derivedId(execution: string): string {
  return createUuidV7(
    Number(BigInt("0x" + execution.replaceAll("-", "").slice(0, 12))),
    createHash("sha256")
      .update(execution + ":caption-v1")
      .digest()
      .subarray(0, 10),
  );
}
class CaptionTool implements ITool {
  constructor(
    private readonly name: string,
    private readonly authority: ToolAuthority,
    private readonly evidence: CaptionEvidenceReader,
  ) {}
  start(input: unknown, context: ToolContext) {
    const controller = new AbortController(),
      abort = () => controller.abort(context.signal.reason);
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) abort();
    const result = this.propose(input as Record<string, unknown>, context, controller.signal)
      .catch((error) => {
        if (error instanceof DomainError) throw new ToolError("invalid_input");
        throw error;
      })
      .finally(() => context.signal.removeEventListener("abort", abort));
    const cancel = async () => {
      controller.abort();
      await result.catch(() => undefined);
    };
    return { result, cancel, forceStop: cancel };
  }
  private async propose(
    input: Record<string, unknown>,
    context: ToolContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    signal.throwIfAborted();
    if (context.resource.kind !== "timeline") throw new ToolError("invalid_subject");
    const timeline = await withAbort(
      this.authority.timeline(context.projectId, context.resource.id),
      signal,
    );
    if (timeline.id !== context.resource.id || timeline.projectId !== context.projectId)
      throw new ToolError("denied");
    const style = captionStyle(input.style);
    let command;
    if (this.name === "add-caption") {
      const asset = input.assetId as string;
      await withAbort(
        this.authority.authorize({ ...context, resource: { kind: "asset", id: asset } }, [
          "project.read",
          "asset.read",
          "analysis.read",
        ]),
        signal,
      );
      const source = timeline.sources.find((s) => s.id === asset);
      if (
        !source ||
        !timeline.tracks.some((t) =>
          t.clips.some((c) => c.kind === "video" && c.sourceId === asset),
        )
      )
        throw new ToolError("invalid_subject");
      const evidence = await withAbort(
        this.evidence.read(
          context.projectId,
          asset,
          input.sourceSha256 as string,
          input.analysisSha256 as string,
          signal,
        ),
        signal,
      );
      if (evidence.durationUs !== String(source.durationUs)) throw new ToolError("invalid_subject");
      const zone = safeCaptionZone(timeline.composition.width, timeline.composition.height, style);
      const maxCharacters = Math.min(
        32,
        Math.floor(
          (zone.width - 2 * (8 + style.outlinePx + style.shadowPx)) / (style.fontSize * 1.2),
        ),
      );
      if (maxCharacters < 8) throw new ToolError("invalid_input");
      const words = captionWords(evidence.words, evidence.durationUs),
        rules = { maxCharacters, maxLines: 2, maxCharactersPerSecond: 24, minDurationUs: "500000" };
      const caption: CaptionTrackV1 = {
        schemaVersion: "1.0.0",
        id: derivedId(context.executionId),
        createdBy: context.callerId,
        assetId: asset,
        sourceSha256: input.sourceSha256 as string,
        sourceDurationUs: evidence.durationUs,
        evidence: {
          kind: "media-analysis",
          documentSha256: input.analysisSha256 as string,
          version: evidence.version,
        },
        style,
        rules,
        blocks: segmentCaptionWords(words, evidence.durationUs, rules),
      };
      command = AddTimedCaption(context.executionId, timeline.id, { caption });
    } else {
      const caption = timeline.captionsV1.find(
        (c) => c.id === input.captionId && c.createdBy === context.callerId,
      );
      if (!caption) throw new ToolError("denied");
      await withAbort(
        this.authority.authorize({ ...context, resource: { kind: "asset", id: caption.assetId } }, [
          "asset.read",
        ]),
        signal,
      );
      command = UpdateCaptionStyle(context.executionId, timeline.id, {
        captionId: caption.id,
        style: style as CaptionStyleV1,
      });
    }
    applyCommand(timeline, command);
    const serialized = serializeCommand(command);
    if (serialized.length > 65536) throw new ToolError("invalid_input");
    signal.throwIfAborted();
    return {
      costMicros: 0,
      output: {
        schemaVersion: 1,
        kind: "timeline-proposal",
        basisSha256: contentHash(timeline.toSnapshot()),
        commands: [serialized],
      },
    };
  }
}
export function registerCaptionTools(
  registry: ToolRegistry,
  authority: ToolAuthority,
  evidence: CaptionEvidenceReader,
): ToolRegistry {
  for (const m of captionToolManifests())
    registry.register(m, {
      mode: "in-process",
      tool: new CaptionTool(m.name.slice(8), authority, evidence),
    });
  return registry;
}

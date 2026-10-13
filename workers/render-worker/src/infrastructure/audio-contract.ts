import path from "node:path";
import { FFprobeMediaProbe } from "@editagent/media-core";
import type { RenderInput, VerifiedAsset } from "../application/ports.js";
import { mapTimeline } from "../application/timeline-mapping.js";

/** Used clips only: source presence cannot come from public composition props. */
export function expectedTimelineAudio(
  input: RenderInput,
  sources: readonly { sourceId: string; audioPresent: boolean }[],
): boolean {
  if (input.compositionId === "FixtureV1") return false;
  return mapTimeline(input).clips.some(
    (m) =>
      m.clip.sourceId !== null &&
      sources.some((s) => s.sourceId === m.clip.sourceId && s.audioPresent),
  );
}
/** Executor independently inspects checksum-verified staged bytes. */
export async function stagedExpectedAudio(
  input: RenderInput,
  assets: readonly VerifiedAsset[],
  work: string,
  signal: AbortSignal,
) {
  if (input.compositionId === "FixtureV1") return false;
  const sources: { sourceId: string; audioPresent: boolean }[] = [];
  for (const asset of assets) {
    if (asset.kind === "image") continue;
    const p = await new FFprobeMediaProbe({ timeoutMs: 10000 }).inspect({
      filePath: path.join(work, asset.name),
      signal,
    });
    sources.push({ sourceId: asset.sourceId, audioPresent: p.audioCodec !== null });
  }
  return expectedTimelineAudio(input, sources);
}

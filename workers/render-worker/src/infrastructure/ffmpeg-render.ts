import path from "node:path";
import { frameTime } from "@editagent/domain";
import {
  FFprobeMediaProbe,
  FfmpegExecutor,
  buildCutRenderArgs,
  type CutSegment,
} from "@editagent/media-core";
import type { TimelineInput, VerifiedAsset, RenderProgress } from "../application/ports.js";
import { mapTimeline } from "../application/timeline-mapping.js";
import { renderEngine } from "../application/strategy-selection.js";

/** Runs only inside the credential-free, constrained executor, never the coordinator. */
export async function renderFfmpegCut(
  input: TimelineInput,
  assets: readonly VerifiedAsset[],
  work: string,
  signal: AbortSignal,
  progress: (p: RenderProgress) => void,
) {
  if (renderEngine(input) !== "ffmpeg") throw new Error("Unsupported FFmpeg timeline.");
  const plan = mapTimeline(input),
    timing = plan.timing;
  const rate = {
    numerator: BigInt(timing.frameRate.numerator),
    denominator: BigInt(timing.frameRate.denominator),
  };
  const metadata = new Map<string, boolean>();
  for (const asset of assets) {
    const p = await new FFprobeMediaProbe({ timeoutMs: 10000 }).inspect({
      filePath: path.join(work, asset.name),
      signal,
    });
    if (!p.videoCodec || p.duration === null) throw new Error("Missing cut video stream.");
    metadata.set(asset.sourceId, p.audioCodec !== null);
  }
  const segments: CutSegment[] = [];
  let cursor = 0;
  for (const m of plan.clips) {
    if (m.from > cursor)
      segments.push({ fromFrame: cursor, frames: m.from - cursor, hasAudio: false });
    const asset = assets.find((a) => a.sourceId === m.clip.sourceId);
    if (!asset) throw new Error("Missing cut source.");
    const startUs =
      BigInt(m.clip.inPoint) + frameTime(BigInt(m.from), rate) - BigInt(m.clip.timelineStartUs);
    segments.push({
      path: path.join(work, asset.name),
      fromFrame: m.from,
      frames: m.durationInFrames,
      sourceStartUs: startUs,
      sourceEndUs: BigInt(m.clip.outPoint),
      hasAudio: metadata.get(asset.sourceId) === true,
    });
    cursor = m.from + m.durationInFrames;
  }
  if (cursor < timing.durationInFrames)
    segments.push({ fromFrame: cursor, frames: timing.durationInFrames - cursor, hasAudio: false });
  const args = buildCutRenderArgs({
    ...timing,
    totalFrames: timing.durationInFrames,
    segments,
    background: input.props.background,
    output: path.join(work, "output.mp4"),
  });
  await new FfmpegExecutor(1).execute(args, {
    signal,
    timeoutMs: 600000,
    processGroup: "supervised",
    maxCaptureBytes: 1048576,
    onProgress: (p) => {
      const count = Math.min(timing.durationInFrames, p.frame);
      progress({
        renderedFrames: count,
        encodedFrames: count,
        totalFrames: timing.durationInFrames,
      });
    },
  });
}

import {
  Timeline,
  frameTime,
  type TimelineSnapshot,
  type ClipSnapshot,
  type FrameRate,
} from "@editagent/domain";
import type { RenderInput, TimelineInput } from "./ports.js";
/** First frame whose rounded canonical microsecond clock is >= boundary. No accumulation. */
export function firstFrameAt(time: bigint, rate: FrameRate): number {
  if (time < 0n) throw new Error("Negative frame boundary.");
  if (time === 0n) return 0;
  const a = (2n * time - 1n) * rate.numerator,
    b = 2000000n * rate.denominator;
  const frame = (a + b - 1n) / b;
  if (frame > 108000n) throw new Error("Render frame budget exceeded.");
  return Number(frame);
}
export function compositionTiming(input: RenderInput) {
  if (input.compositionId === "FixtureV1")
    return {
      width: input.width,
      height: input.height,
      frameRate: input.frameRate,
      durationInFrames: input.durationInFrames,
    };
  const c = input.props.timeline.composition;
  const rate = {
    numerator: BigInt(c.frameRate.numerator),
    denominator: BigInt(c.frameRate.denominator),
  };
  return {
    width: c.width,
    height: c.height,
    frameRate: { numerator: Number(rate.numerator), denominator: Number(rate.denominator) },
    durationInFrames: firstFrameAt(BigInt(c.durationUs), rate),
  };
}
export interface MappedClip {
  clip: ClipSnapshot;
  from: number;
  durationInFrames: number;
  sourceOffsetFrames: number;
  opacity: number;
  volume: number;
  fadeInFrames: number;
  holdFrames: number;
  layer: number;
}
export interface TimelinePlan {
  clips: MappedClip[];
  timing: ReturnType<typeof compositionTiming>;
}
export function mapTimeline(input: TimelineInput): TimelinePlan {
  const snapshot: TimelineSnapshot = Timeline.restore(input.props.timeline).toSnapshot();
  const c = snapshot.composition,
    rate = {
      numerator: BigInt(c.frameRate.numerator),
      denominator: BigInt(c.frameRate.denominator),
    };
  const timing = compositionTiming(input);
  const fps = timing.frameRate.numerator / timing.frameRate.denominator;
  if (
    fps < 1 ||
    fps > 60 ||
    rate.numerator > 60000n ||
    rate.denominator > 1001n ||
    timing.durationInFrames < 1 ||
    BigInt(c.durationUs) > 1800000000n ||
    c.width % 2 ||
    c.height % 2 ||
    c.width > 4096 ||
    c.height > 4096 ||
    c.width * c.height > 8294400 ||
    snapshot.sources.length > 128 ||
    snapshot.tracks.length > 64 ||
    snapshot.sources.some((s) => BigInt(s.durationUs) > 1800000000n)
  )
    throw new Error("Timeline render admission exceeded.");
  const bindings = new Map(input.props.components.map((b) => [b.componentId, b]));
  if (bindings.size !== input.props.components.length)
    throw new Error("Duplicate component binding.");
  const clips: MappedClip[] = [];
  snapshot.tracks.forEach((track, layer) => {
    for (const clip of track.clips) {
      if (clip.text !== null && clip.text.length > 1000)
        throw new Error("Caption render budget exceeded.");
      if (clip.kind === "graphics" && (!clip.componentId || !bindings.has(clip.componentId)))
        throw new Error("Unknown graphics component.");
      const start = BigInt(clip.timelineStartUs),
        end = start + BigInt(clip.outPoint) - BigInt(clip.inPoint);
      const from = firstFrameAt(start, rate),
        until = firstFrameAt(end, rate);
      if (until <= from) throw new Error("Clip has no visible composition frame.");
      const sourceOffsetUs = BigInt(clip.inPoint) + frameTime(BigInt(from), rate) - start;
      const opacity = clip.effects
        .filter((e) => e.kind === "opacity")
        .reduce((v, e) => v * e.value, clip.opacity);
      const gain = clip.effects
        .filter((e) => e.kind === "gain")
        .reduce((v, e) => v + e.value, clip.volumeDb);
      const incoming = track.transitions.find(
        (t) => t.toClipId === clip.id && t.kind === "dissolve",
      );
      const outgoing = track.transitions.find(
        (t) => t.fromClipId === clip.id && t.kind === "dissolve",
      );
      const transitionFrames = (us: string) =>
        Math.max(1, firstFrameAt(end + BigInt(us), rate) - until);
      const fadeInFrames = incoming
        ? Math.max(1, firstFrameAt(start + BigInt(incoming.durationUs), rate) - from)
        : 0;
      const holdFrames = outgoing ? transitionFrames(outgoing.durationUs) : 0;
      clips.push({
        clip,
        from,
        durationInFrames: until - from,
        sourceOffsetFrames: (Number(sourceOffsetUs) * fps) / 1000000,
        opacity,
        volume: Math.pow(10, Math.min(12, Math.max(-60, gain)) / 20),
        fadeInFrames,
        holdFrames,
        layer,
      });
    }
  });
  if (clips.length > 2048) throw new Error("Timeline clip budget exceeded.");
  return { clips, timing };
}

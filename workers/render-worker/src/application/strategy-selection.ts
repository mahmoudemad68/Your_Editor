import { Timeline, frameTime } from "@editagent/domain";
import type { IRenderStrategy, RenderInput } from "./ports.js";
/** Conservative supported subset. Unsupported features retain the Remotion implementation. */
export function renderEngine(input: RenderInput): "ffmpeg" | "remotion" {
  if (input.compositionId !== "TimelineV1") return "remotion";
  const t = Timeline.restore(input.props.timeline).toSnapshot();
  const active = t.tracks.filter((track) => track.clips.length > 0);
  if (
    active.length !== 1 ||
    active[0]!.kind !== "video" ||
    active[0]!.clips.length > 8 ||
    t.sources.some((s) => s.kind !== "video")
  )
    return "remotion";
  const rate = {
    numerator: BigInt(t.composition.frameRate.numerator),
    denominator: BigInt(t.composition.frameRate.denominator),
  };
  const onGrid = (v: string) => {
    const time = BigInt(v),
      index = (time * rate.numerator + 500000n * rate.denominator) / (1000000n * rate.denominator);
    return frameTime(index, rate) === time;
  };
  if (
    active[0]!.transitions.some((tr) => tr.kind !== "cut") ||
    active[0]!.clips.some(
      (c) =>
        c.kind !== "video" ||
        c.effects.length ||
        c.opacity !== 1 ||
        c.volumeDb !== 0 ||
        !onGrid(c.timelineStartUs) ||
        !onGrid(c.inPoint) ||
        !onGrid(c.outPoint) ||
        !onGrid((BigInt(c.timelineStartUs) + BigInt(c.outPoint) - BigInt(c.inPoint)).toString()),
    )
  )
    return "remotion";
  return "ffmpeg";
}
export class SelectingRenderStrategy implements IRenderStrategy {
  constructor(
    private readonly ffmpeg: IRenderStrategy,
    private readonly remotion: IRenderStrategy,
  ) {}
  render(...args: Parameters<IRenderStrategy["render"]>) {
    return (renderEngine(args[0]) === "ffmpeg" ? this.ffmpeg : this.remotion).render(...args);
  }
  discard(artifact: Parameters<IRenderStrategy["discard"]>[0]) {
    return this.remotion.discard(artifact);
  }
}

import React from "react";
import {
  AbsoluteFill,
  Sequence,
  OffthreadVideo,
  Audio,
  Img,
  Freeze,
  staticFile,
  useCurrentFrame,
} from "remotion";
import type { ComponentBinding, VerifiedAsset, TimelineInput } from "../application/ports.js";
import type { MappedClip, TimelinePlan } from "../application/timeline-mapping.js";
export interface TimelineCompositionProps extends Record<string, unknown> {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  plan: TimelinePlan;
  assets: VerifiedAsset[];
  components: ComponentBinding[];
  captionStyle: TimelineInput["props"]["captionStyle"];
  background: string;
}
function content(m: MappedClip, p: TimelineCompositionProps, hold = false) {
  const c = m.clip;
  if (c.kind === "caption")
    return (
      <AbsoluteFill
        style={{
          justifyContent: "flex-end",
          alignItems: "center",
          padding: 16,
          fontFamily: "DejaVu Sans",
          fontSize: p.captionStyle.fontSize,
          color: p.captionStyle.color,
        }}
      >
        <div
          dir={p.captionStyle.direction}
          style={{
            backgroundColor: p.captionStyle.background,
            padding: 8,
            whiteSpace: "pre-wrap",
            maxWidth: "100%",
            overflowWrap: "anywhere",
          }}
        >
          {c.text}
        </div>
      </AbsoluteFill>
    );
  if (c.kind === "graphics") {
    const b = p.components.find((b) => b.componentId === c.componentId)!;
    // The contract and factory admit only these compile-time implementations.
    if (b.type === "solid-v1") return <AbsoluteFill style={{ backgroundColor: b.props.color }} />;
    if (b.type === "title-v1")
      return (
        <AbsoluteFill
          style={{
            backgroundColor: b.props.background,
            color: b.props.color,
            fontFamily: "DejaVu Sans",
            fontSize: b.props.fontSize,
            alignItems: "center",
            justifyContent: "center",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {b.props.text}
        </AbsoluteFill>
      );
    throw new Error("Unknown registered component.");
  }
  const a = p.assets.find((a) => a.sourceId === c.sourceId);
  if (!a) throw new Error("Missing verified source.");
  const src = staticFile(a.name);
  if (c.kind === "audio")
    return hold ? null : <Audio src={src} trimBefore={m.sourceOffsetFrames} volume={m.volume} />;
  if (a.kind === "image")
    return <Img src={src} style={{ width: "100%", height: "100%", objectFit: "contain" }} />;
  return (
    <OffthreadVideo
      src={src}
      trimBefore={m.sourceOffsetFrames}
      muted={hold}
      volume={m.volume}
      style={{ width: "100%", height: "100%", objectFit: "contain" }}
    />
  );
}
const Visible: React.FC<{ mapped: MappedClip; p: TimelineCompositionProps; hold?: boolean }> = ({
  mapped: m,
  p,
  hold = false,
}) => {
  const f = useCurrentFrame();
  const alpha = !hold && m.fadeInFrames > 0 ? Math.min(1, (f + 1) / m.fadeInFrames) : 1;
  return (
    <AbsoluteFill style={{ opacity: m.opacity * alpha }}>
      {hold ? <Freeze frame={m.durationInFrames - 1}>{content(m, p, true)}</Freeze> : content(m, p)}
    </AbsoluteFill>
  );
};
export const TimelineComposition: React.FC<TimelineCompositionProps> = (p) => (
  <AbsoluteFill style={{ backgroundColor: p.background }}>
    {p.plan.clips.map((m) => (
      <React.Fragment key={m.clip.id}>
        <Sequence from={m.from} durationInFrames={m.durationInFrames} name={m.clip.id}>
          <Visible mapped={m} p={p} />
        </Sequence>
        {m.holdFrames > 0 && (
          <Sequence from={m.from + m.durationInFrames} durationInFrames={m.holdFrames}>
            <Visible mapped={m} p={p} hold />
          </Sequence>
        )}
      </React.Fragment>
    ))}
  </AbsoluteFill>
);

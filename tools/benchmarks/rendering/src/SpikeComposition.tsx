import React from "react";
import {
  AbsoluteFill,
  OffthreadVideo,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import captions from "../captions.json";
import spec from "../spec.json";

/** Fixed 60-second vertical composition. The title moves and changes opacity every frame. */
export const SpikeComposition: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const seconds = frame / fps;
  const opacity = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin((2 * Math.PI * seconds) / 3));
  const offsetY = 50 * Math.sin((2 * Math.PI * seconds) / 4);
  const caption = captions.find((item) => seconds >= item.start && seconds < item.end);

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <OffthreadVideo src={staticFile("source-60s.mp4")} />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 140 + offsetY,
          opacity,
          textAlign: "center",
          color: "white",
          fontFamily: spec.fontFamily,
          fontSize: 84,
          fontWeight: 700,
          textShadow: "0 4px 16px rgba(0,0,0,0.65)",
        }}
      >
        {spec.title}
      </div>
      <div
        style={{
          position: "absolute",
          left: 64,
          right: 64,
          bottom: 140,
          padding: "18px 24px",
          borderRadius: 12,
          backgroundColor: "rgba(0,0,0,0.55)",
          color: "white",
          fontFamily: spec.fontFamily,
          fontSize: 42,
          lineHeight: 1.25,
          textAlign: "center",
        }}
      >
        {caption?.text ?? ""}
      </div>
    </AbsoluteFill>
  );
};

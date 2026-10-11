import React from "react";
import { registerRoot, Composition, AbsoluteFill, useCurrentFrame } from "remotion";
import { TimelineComposition, type TimelineCompositionProps } from "./timeline.js";
export interface FixtureProps extends Record<string, unknown> {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  title: string;
  background: string;
}
const Fixture: React.FC<FixtureProps> = ({ title, background }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        backgroundColor: background,
        color: "white",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "DejaVu Sans",
        fontSize: 24,
      }}
    >
      <div>{title}</div>
      <div>{frame}</div>
    </AbsoluteFill>
  );
};
const defaults: FixtureProps = {
  width: 320,
  height: 180,
  fps: 30,
  durationInFrames: 150,
  title: "EditAgent",
  background: "#16324f",
};
registerRoot(() => (
  <>
    <Composition
      id="FixtureV1"
      component={Fixture}
      width={320}
      height={180}
      fps={30}
      durationInFrames={150}
      defaultProps={defaults}
      calculateMetadata={({ props }) => ({
        width: props.width,
        height: props.height,
        fps: props.fps,
        durationInFrames: props.durationInFrames,
      })}
    />
    <Composition
      id="TimelineV1"
      component={TimelineComposition}
      width={320}
      height={180}
      fps={30}
      durationInFrames={1}
      defaultProps={
        {
          width: 320,
          height: 180,
          fps: 30,
          durationInFrames: 1,
          plan: {
            clips: [],
            timing: {
              width: 320,
              height: 180,
              frameRate: { numerator: 30, denominator: 1 },
              durationInFrames: 1,
            },
          },
          assets: [],
          components: [],
          background: "#000000",
          captionStyle: {
            color: "#ffffff",
            background: "#000000",
            fontSize: 24,
            direction: "auto",
          },
        } satisfies TimelineCompositionProps
      }
      calculateMetadata={({ props }) => ({
        width: props.width,
        height: props.height,
        fps: props.fps,
        durationInFrames: props.durationInFrames,
      })}
    />
  </>
));

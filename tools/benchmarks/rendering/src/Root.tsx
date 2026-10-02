import React from "react";
import { Composition } from "remotion";
import spec from "../spec.json";
import { SpikeComposition } from "./SpikeComposition";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Spike60"
      component={SpikeComposition}
      durationInFrames={spec.durationSeconds * spec.fps}
      fps={spec.fps}
      width={spec.width}
      height={spec.height}
    />
  );
};

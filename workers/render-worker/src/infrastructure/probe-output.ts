import { compositionTiming } from "../application/timeline-mapping.js";
import { stat } from "node:fs/promises";
import { FFprobeMediaProbe, buildFfmpegArgs, FfmpegExecutor } from "@editagent/media-core";
import type { RenderInput } from "../application/ports.js";
export async function validateOutput(filePath: string, input: RenderInput, signal?: AbortSignal) {
  const timing = compositionTiming(input);
  const size = (await stat(filePath)).size;
  if (size < 1 || size > 1073741824) throw new Error("Invalid render output size.");
  const p = await new FFprobeMediaProbe({ timeoutMs: 10000 }).inspect({
    filePath,
    ...(signal ? { signal } : {}),
  });
  const fps = timing.frameRate.numerator / timing.frameRate.denominator;
  const duration =
    (BigInt(timing.durationInFrames) * 1000000n * BigInt(timing.frameRate.denominator) +
      BigInt(Math.floor(timing.frameRate.numerator / 2))) /
    BigInt(timing.frameRate.numerator);
  const delta = p.duration === null ? duration : p.duration - duration;
  if (
    p.container !== "MP4" ||
    p.videoCodec !== "h264" ||
    !p.streams.some((s) => s.codecType === "video") ||
    p.width !== timing.width ||
    p.height !== timing.height ||
    !p.frameRate ||
    p.frameRate.numerator * BigInt(timing.frameRate.denominator) !==
      p.frameRate.denominator * BigInt(timing.frameRate.numerator) ||
    p.duration === null ||
    delta > BigInt(Math.ceil(500000 / fps)) ||
    delta < -BigInt(Math.ceil(500000 / fps))
  )
    throw new Error(
      "Rendered MP4 does not match its contract: " +
        JSON.stringify({
          container: p.container,
          codec: p.videoCodec,
          width: p.width,
          height: p.height,
          frameRate: p.frameRate ? `${p.frameRate.numerator}:${p.frameRate.denominator}` : null,
          durationUs: String(p.duration),
          expectedDurationUs: String(duration),
        }),
    );
  let decodedFrames = 0;
  await new FfmpegExecutor(1).execute(
    buildFfmpegArgs({
      input: { path: filePath },
      // The hardened media-core builder requires an explicit admitted video encoder.
      // Decode every frame and discard the verification encode; never alter the uploaded MP4.
      output: { format: "null", maps: ["0:v:0"], videoEncoder: "libx264" },
      progress: true,
    }),
    {
      timeoutMs: 300000,
      ...(signal ? { signal } : {}),
      maxCaptureBytes: 1048576,
      onProgress: (p) => {
        decodedFrames = p.frame;
      },
    },
  );
  if (decodedFrames !== timing.durationInFrames)
    throw new Error("Rendered MP4 frame count does not match its contract.");
  return {
    decodedFrames,
    byteSize: size,
    durationUs: String(p.duration),
    width: p.width,
    height: p.height,
    frameRate: {
      numerator: String(p.frameRate.numerator),
      denominator: String(p.frameRate.denominator),
    },
    codec: p.videoCodec,
  };
}

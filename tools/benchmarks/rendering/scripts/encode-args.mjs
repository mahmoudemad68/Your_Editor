import { loadSpec } from "./load-spec.mjs";

export function encodeArgs() {
  const spec = loadSpec();
  return [
    "-c:v",
    spec.encoder,
    "-pix_fmt",
    spec.pixelFormat,
    "-r",
    String(spec.fps),
    "-crf",
    String(spec.crf),
    "-preset",
    spec.x264Preset,
    "-c:a",
    spec.audioCodec,
    "-b:a",
    spec.audioBitrate,
    "-movflags",
    "+faststart",
  ];
}

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { benchmarkRoot, loadSpec } from "./load-spec.mjs";

const spec = loadSpec();
const root = benchmarkRoot();
const output = path.join(root, "fixtures", "source-60s.mp4");
mkdirSync(path.dirname(output), { recursive: true });

const video = `testsrc2=size=${spec.width}x${spec.height}:rate=${spec.fps}:duration=${spec.durationSeconds}`;
const audio = `sine=frequency=440:sample_rate=${spec.audioSampleRate}:duration=${spec.durationSeconds}`;
const result = spawnSync(
  "ffmpeg",
  [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    video,
    "-f",
    "lavfi",
    "-i",
    audio,
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
    "-shortest",
    "-movflags",
    "+faststart",
    output,
  ],
  { stdio: "inherit" },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

process.stdout.write(`${output}\n`);

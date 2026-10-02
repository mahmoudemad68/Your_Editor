import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { benchmarkRoot, loadCaptions, loadSpec } from "./load-spec.mjs";

const output = process.argv[2];
if (output === undefined) {
  process.stderr.write("usage: ffmpeg-decorated.mjs <output.mp4>\n");
  process.exit(1);
}

const spec = loadSpec();
const captions = loadCaptions();
const source = path.join(benchmarkRoot(), "fixtures", "source-60s.mp4");
mkdirSync(path.dirname(output), { recursive: true });

function escapeDrawtext(text) {
  return text.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll(",", "\\,");
}

function drawtext(options) {
  return `drawtext=${options.join(":")}`;
}

const filters = [
  drawtext([
    `fontfile=${spec.fontFile}`,
    `text=${escapeDrawtext(spec.title)}`,
    "fontsize=84",
    "fontcolor=white",
    "x=(w-text_w)/2",
    "y=140+50*sin(2*PI*t/4)",
    "alpha=0.45+0.55*(0.5+0.5*sin(2*PI*t/3))",
  ]),
];
for (const caption of captions) {
  filters.push(
    drawtext([
      `fontfile=${spec.fontFile}`,
      `text=${escapeDrawtext(caption.text)}`,
      "fontsize=42",
      "fontcolor=white",
      "box=1",
      "boxcolor=black@0.55",
      "boxborderw=18",
      "x=(w-text_w)/2",
      "y=h-220",
      `enable='between(t,${caption.start},${caption.end})'`,
    ]),
  );
}

const result = spawnSync(
  "ffmpeg",
  [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    source,
    "-vf",
    filters.join(","),
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
    output,
  ],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);

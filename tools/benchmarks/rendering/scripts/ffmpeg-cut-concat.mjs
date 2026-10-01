import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { encodeArgs } from "./encode-args.mjs";
import { benchmarkRoot, loadSpec } from "./load-spec.mjs";

const output = process.argv[2];
if (output === undefined) {
  process.stderr.write("usage: ffmpeg-cut-concat.mjs <output.mp4>\n");
  process.exit(1);
}

const spec = loadSpec();
const root = benchmarkRoot();
const source = path.join(root, "fixtures", "source-60s.mp4");
const segmentDir = path.join(root, "fixtures", "segments");
mkdirSync(segmentDir, { recursive: true });
mkdirSync(path.dirname(output), { recursive: true });

const piece = spec.durationSeconds / 3;
const segments = [0, 1, 2].map((index) => path.join(segmentDir, `piece-${index}.mp4`));
for (const [index, segment] of segments.entries()) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      source,
      "-ss",
      String(index * piece),
      "-t",
      String(piece),
      ...encodeArgs(),
      segment,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const list = path.join(segmentDir, "concat.txt");
writeFileSync(list, segments.map((segment) => `file '${segment}'`).join("\n") + "\n");
const concatenated = spawnSync(
  "ffmpeg",
  [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-c",
    "copy",
    output,
  ],
  { stdio: "inherit" },
);
process.exit(concatenated.status ?? 1);

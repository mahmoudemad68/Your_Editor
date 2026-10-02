import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const input = process.argv[2];
const directory = process.argv[3];
if (input === undefined || directory === undefined) {
  process.stderr.write("usage: extract-frames.mjs <video> <directory>\n");
  process.exit(1);
}
mkdirSync(directory, { recursive: true });
const stamps = [
  ["title-1s", "1", "1080:220:0:120"],
  ["title-8s", "8", "1080:220:0:120"],
  ["caption-1s", "1", "1080:220:0:1580"],
  ["caption-12s", "12", "1080:220:0:1580"],
  ["full-30s", "30", "1080:1920:0:0"],
];
for (const [name, stamp, crop] of stamps) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      stamp,
      "-i",
      input,
      "-vf",
      `crop=${crop}`,
      "-frames:v",
      "1",
      path.join(directory, `${name}.png`),
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

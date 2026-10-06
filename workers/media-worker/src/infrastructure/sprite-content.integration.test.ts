import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { test } from "node:test";
import { createUuidV7, instant, MediaAsset, mediaAssetId, projectId } from "@editagent/domain";
import { FFprobeMediaProbe } from "@editagent/media-core";
import { derivativePlans, type DerivativePlan } from "../application/derivative-plan.js";
import { FFmpegDerivativeProcessor } from "./ffmpeg-derivative-processor.js";

const WIDTH = 320;
const HEIGHT = 180;
const SOURCE_FPS = 30;
const FRAME_US = 1_000_000 / SOURCE_FPS;
const id = () => createUuidV7(Date.now(), randomBytes(10));
const abort = () => new AbortController().signal;

/** Human-readable seven-segment decimal counter plus twelve large binary cells.
 * Every input frame carries its ORIGINAL frame index; selection/resampling cannot
 * manufacture a newer identity. Buffers stream to the fixture encoder, not RAM.
 */
function counterFrame(frameNumber: number): Buffer {
  const bytes = Buffer.alloc(WIDTH * HEIGHT * 3, 16);
  function rect(x: number, y: number, width: number, height: number) {
    for (let row = y; row < y + height; row++)
      for (let col = x; col < x + width; col++)
        bytes.fill(245, (row * WIDTH + col) * 3, (row * WIDTH + col) * 3 + 3);
  }
  const digits = [63, 6, 91, 79, 102, 109, 125, 7, 127, 111];
  for (const [index, digit] of [...String(frameNumber).padStart(4, "0")].entries()) {
    const x = 38 + index * 62;
    const y = 24;
    const segments = [
      [x + 6, y, 28, 6],
      [x + 34, y + 6, 6, 28],
      [x + 34, y + 40, 6, 28],
      [x + 6, y + 68, 28, 6],
      [x, y + 40, 6, 28],
      [x, y + 6, 6, 28],
      [x + 6, y + 34, 28, 6],
    ];
    for (const [bit, box] of segments.entries())
      if ((digits[Number(digit)]! & (1 << bit)) !== 0) rect(box[0]!, box[1]!, box[2]!, box[3]!);
  }
  // White synchronization markers make a missing/incorrectly rotated crop fail.
  rect(4, 134, 8, 24);
  rect(308, 134, 8, 24);
  for (let bit = 0; bit < 12; bit++)
    if ((frameNumber & (1 << bit)) !== 0) rect(16 + 24 * bit, 134, 20, 24);
  return bytes;
}

async function fixture(file: string, frames: number, rate: string, vfr = false): Promise<void> {
  const args = [
    "-v",
    "error",
    "-y",
    "-threads",
    "2",
    "-f",
    "rawvideo",
    "-pixel_format",
    "rgb24",
    "-video_size",
    `${WIDTH}x${HEIGHT}`,
    "-framerate",
    rate,
    "-i",
    "pipe:0",
    ...(vfr ? ["-vf", "select='not(eq(mod(n,5),0)*gt(n,0))'", "-fps_mode", "vfr"] : []),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "10",
    "-pix_fmt",
    "yuv420p",
    "-video_track_timescale",
    "1000000",
    "-threads",
    "2",
    file,
  ];
  const child = spawn("ffmpeg", args, { shell: false, stdio: ["pipe", "ignore", "pipe"] });
  let diagnostic = "";
  child.stderr.on("data", (data: Buffer) => {
    diagnostic = (diagnostic + data.toString()).slice(-8192);
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
  const exited = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`Fixture encode failed: ${diagnostic}`)),
    );
  });
  async function* pixels() {
    for (let n = 0; n < frames; n++) yield counterFrame(n);
  }
  try {
    await Promise.all([pipeline(Readable.from(pixels()), child.stdin), exited]);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await exited.catch(() => undefined);
    }
  }
}

function command(executable: string, args: string[], maxBuffer = 2_000_000): Buffer {
  const result = spawnSync(executable, args, { timeout: 30000, maxBuffer });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}
async function source(file: string): Promise<MediaAsset> {
  const bytes = await readFile(file); // small synthetic fixtures only
  return MediaAsset.createUploaded({
    id: mediaAssetId(id()),
    projectId: projectId(id()),
    createdAt: instant(1n),
    displayFilename: "visible-counter.mp4",
    mimeType: "video/mp4",
    byteSize: (await stat(file)).size,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
  }).recordInspection(await new FFprobeMediaProbe().inspect({ filePath: file }), instant(2n));
}

/** Decode the cells from the pixels of each actual JPEG crop, not its metadata.
 * For the rotated source, invert its known +90° display rotation and fit/padding
 * coordinates. Neighbor means stay inside each large cell despite JPEG edges.
 */
function tileIdentity(rgb: Buffer, plan: DerivativePlan, tile: number, rotated: boolean): number {
  const columns = Number(plan.parameters["columns"]);
  const sheetWidth = columns * 160;
  const ox = (tile % columns) * 160;
  const oy = Math.floor(tile / columns) * 90;
  function luminance(x: number, y: number): number {
    const tx = rotated ? 54 + Math.floor(((y + 0.5) * 51) / HEIGHT) : Math.floor(x / 2);
    const ty = rotated ? Math.floor(((WIDTH - 1 - x + 0.5) * 90) / WIDTH) : Math.floor(y / 2);
    let sum = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const offset = ((oy + ty + dy) * sheetWidth + ox + tx + dx) * 3;
        sum += rgb[offset]! + rgb[offset + 1]! + rgb[offset + 2]!;
      }
    return sum / 27;
  }
  assert.ok(
    luminance(8, 146) > 128 && luminance(312, 146) > 128,
    "counter synchronization markers survive crop/rotation",
  );
  let identity = 0;
  for (let bit = 0; bit < 12; bit++) if (luminance(26 + 24 * bit, 146) > 128) identity |= 1 << bit;
  return identity;
}

test(
  "sprite CONTENT matches persisted midpoints using real visible original-frame counters",
  { timeout: 120000 },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "us128-sprite-counter-"));
    const processor = new FFmpegDerivativeProcessor(
      process.env["FFMPEG_PATH"] ?? "ffmpeg",
      process.env["FFPROBE_PATH"] ?? "ffprobe",
    );
    try {
      for (const [name, frames, vfr, rotated] of [
        ["2s", 60, false, false],
        ["11s", 330, false, false],
        ["120s", 3600, false, false],
        ["very-short", 1, false, false],
        ["VFR", 330, true, false],
        ["rotated", 330, false, true],
      ] as const)
        await t.test(name, async () => {
          let file = path.join(directory, `${name}.mp4`);
          await fixture(file, frames, String(SOURCE_FPS), vfr);
          if (rotated) {
            const rotatedFile = path.join(directory, "rotated-tagged.mp4");
            command("ffmpeg", [
              "-v",
              "error",
              "-y",
              "-display_rotation",
              "90",
              "-i",
              file,
              "-c",
              "copy",
              rotatedFile,
            ]);
            file = rotatedFile;
          }
          const asset = await source(file);
          if (vfr) assert.equal(asset.frameRateMode, "variable");
          if (rotated) assert.equal(asset.rotation, 90);
          const plan = derivativePlans(asset).find((p) => p.variant === "sprite")!;
          const timestamps = plan.parameters["timestampsUs"] as number[];
          const prepared = await processor.prepare(asset, file, abort());
          try {
            const output = await prepared.generate(plan, abort());
            const columns = Number(plan.parameters["columns"]);
            const rows = Number(plan.parameters["rows"]);
            assert.ok(timestamps.length <= 20 && columns <= 5);
            const rgb = command("ffmpeg", [
              "-v",
              "error",
              "-threads",
              "1",
              "-i",
              output.filePath,
              "-frames:v",
              "1",
              "-threads",
              "1",
              "-pix_fmt",
              "rgb24",
              "-f",
              "rawvideo",
              "pipe:1",
            ]);
            assert.equal(rgb.length, columns * 160 * rows * 90 * 3, "actual sprite geometry");
            const identities = timestamps.map((_at, i) => tileIdentity(rgb, plan, i, rotated));
            if (vfr)
              assert.ok(
                identities.every((n) => n % 5 !== 0),
                "midpoint frames were actually removed from the VFR fixture",
              );
            const toleranceUs = vfr ? 2 * FRAME_US : FRAME_US;
            console.log(
              "SPRITE_VISIBLE_COUNTER",
              JSON.stringify({
                name,
                timestampsUs: timestamps,
                originalFrameIdentities: identities,
                actualTimestampsUs: identities.map((n) => n * FRAME_US),
                toleranceUs,
                columns,
                rows,
              }),
            );
            for (const [i, timestamp] of timestamps.entries())
              assert.ok(
                Math.abs(identities[i]! * FRAME_US - timestamp) <= toleranceUs + 1,
                `${name} tile ${i}: visible frame ${identities[i]} at ${identities[i]! * FRAME_US}us differs from persisted ${timestamp}us`,
              );
          } finally {
            await prepared.release();
          }
        });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "proxy frame cap is not an exact-count guarantee; real one-frame and N-frame boundaries preserve AC1",
  { timeout: 60000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "us128-proxy-boundary-"));
    const processor = new FFmpegDerivativeProcessor(
      process.env["FFMPEG_PATH"] ?? "ffmpeg",
      process.env["FFPROBE_PATH"] ?? "ffprobe",
    );
    try {
      for (const durationUs of [33332, 33333, 33334, 100000, 100001, 1001000]) {
        const file = path.join(directory, `${durationUs}.mp4`);
        await fixture(file, 1, `1000000/${durationUs}`);
        const asset = await source(file);
        assert.ok(
          Math.abs(Number(asset.duration) - durationUs) <= 1,
          "independently probed real boundary source",
        );
        const plan = derivativePlans(asset).find((p) => p.variant === "proxy")!;
        const prepared = await processor.prepare(asset, file, abort());
        try {
          const output = await prepared.generate(plan, abort());
          const probe = JSON.parse(
            command("ffprobe", [
              "-v",
              "error",
              "-count_frames",
              "-show_streams",
              "-show_format",
              "-of",
              "json",
              output.filePath,
            ]).toString(),
          ) as {
            streams: { avg_frame_rate: string; nb_read_frames: string }[];
            format: { duration: string };
          };
          const count = Number(probe.streams[0]!.nb_read_frames);
          const cap = Math.ceil((Number(asset.duration) * 30) / 1_000_000);
          assert.equal(probe.streams[0]!.avg_frame_rate, "30/1");
          assert.ok(count > 0 && count <= cap);
          assert.ok(
            Math.abs(Number(probe.format.duration) * 1_000_000 - Number(asset.duration)) <=
              FRAME_US + 1,
          );
          if (durationUs === 1001000) {
            assert.equal(cap, 31);
            assert.equal(count, 30);
          }
          console.log(
            "PROXY_BOUNDARY",
            JSON.stringify({
              sourceDurationUs: asset.duration?.toString(),
              cap,
              actualFrames: count,
              outputDurationUs: Number(probe.format.duration) * 1_000_000,
            }),
          );
        } finally {
          await prepared.release();
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

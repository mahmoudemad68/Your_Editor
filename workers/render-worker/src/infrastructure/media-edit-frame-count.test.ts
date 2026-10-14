import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { executeMediaEdit } from "./media-edit.js";

test(
  "QA53-L1: production resize retains all 179 CFR frames despite a longer AAC tail",
  { timeout: 30000 },
  async () => {
    const work = await mkdtemp(path.join(tmpdir(), "resize-aac-tail-"));
    try {
      const file = path.join(work, "source.mp4");
      execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=s=64x64:r=30000/1001",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=1000:sample_rate=48000:duration=6",
          "-filter:v",
          "trim=end_frame=179",
          "-c:v",
          "libx264",
          "-threads",
          "1",
          "-bf",
          "3",
          "-pix_fmt",
          "yuv420p",
          "-video_track_timescale",
          "30000",
          "-c:a",
          "aac",
          "-movie_timescale",
          "48000",
          file,
        ],
        { timeout: 15000 },
      );
      const probe = (file: string) =>
        JSON.parse(
          execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file], {
            encoding: "utf8",
            timeout: 10000,
          }),
        );
      const before = probe(file),
        v = before.streams.find((s: { codec_type: string }) => s.codec_type === "video"),
        a = before.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
      assert.equal(Number(v.nb_frames), 179);
      assert.equal(v.duration_ts, 179179);
      assert.equal(a.duration_ts, 288000);
      assert.ok(Number(a.duration) - Number(v.duration) > 0.027);
      const bytes = await readFile(file),
        sha = createHash("sha256").update(bytes).digest("hex"),
        id = "018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f";
      await executeMediaEdit(
        {
          schemaVersion: 1,
          kind: "media-edit-v1",
          renderVersion: "a".repeat(64),
          operation: "resize_video",
          sources: [{ id, kind: "video", durationUs: "6000000" }],
          parameters: { assetId: id, width: 128, height: 128 },
        },
        [
          {
            sourceId: id,
            kind: "video",
            durationUs: "6000000",
            sha256: sha,
            byteSize: bytes.length,
            name: "source.mp4",
          },
        ],
        work,
        new AbortController().signal,
        () => {},
      );
      const output = path.join(work, "output.mp4"),
        out = probe(output),
        video = out.streams.find((s: { codec_type: string }) => s.codec_type === "video"),
        audio = out.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
      assert.equal(video.width, 128);
      assert.equal(video.height, 128);
      assert.equal(video.avg_frame_rate, "30000/1001");
      assert.equal(video.duration_ts, 179179);
      assert.equal(Number(video.nb_frames), 179);
      assert.equal(audio.duration_ts, 286686);
      const decoded = execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-threads",
          "1",
          "-i",
          output,
          "-map",
          "0:v:0",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "-threads",
          "1",
          "-",
        ],
        { maxBuffer: 10000000, timeout: 10000 },
      );
      assert.equal(decoded.length, 179 * 128 * 128 * 3);
      assert.equal(
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
        sha,
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);

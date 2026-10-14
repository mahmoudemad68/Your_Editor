import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FFprobeMediaProbe, parseSpatialVideoTiming } from "./ffprobe-adapter.js";
import { MediaProbeError } from "@editagent/domain";

const rate = { numerator: 30000, denominator: 1001 };
const valid = () => ({
  streams: [
    {
      codec_type: "video",
      time_base: "1/30000",
      start_pts: 0,
      duration_ts: 2002,
      nb_frames: "2",
      nb_read_frames: "2",
      avg_frame_rate: "30000/1001",
      r_frame_rate: "30000/1001",
    },
  ],
  frames: [
    { pts: 0, best_effort_timestamp: 0, duration: 1001 },
    { pts: 1001, best_effort_timestamp: 1001, duration: 1001 },
  ],
});

test("spatial census requires decoded count, declared timing, every PTS and every frame duration to agree", () => {
  assert.deepEqual(parseSpatialVideoTiming(valid(), rate), { frameCount: 2, durationUs: 66733n });
  const missingHeaderCount = valid();
  delete (missingHeaderCount.streams[0] as { nb_frames?: string }).nb_frames;
  assert.equal(parseSpatialVideoTiming(missingHeaderCount, rate).frameCount, 2);
  for (const mutate of [
    (v: ReturnType<typeof valid>) => {
      v.streams[0]!.nb_frames = "12";
    },
    (v: ReturnType<typeof valid>) => {
      v.streams[0]!.nb_read_frames = "12";
    },
    (v: ReturnType<typeof valid>) => {
      v.streams[0]!.duration_ts = 12012;
    },
    (v: ReturnType<typeof valid>) => {
      v.streams[0]!.r_frame_rate = "30/1";
    },
    (v: ReturnType<typeof valid>) => {
      v.frames[1]!.pts = 0;
    },
    (v: ReturnType<typeof valid>) => {
      v.frames[1]!.pts = 2002;
    },
    (v: ReturnType<typeof valid>) => {
      v.frames[1]!.duration = 1000;
    },
    (v: ReturnType<typeof valid>) => {
      v.frames.pop();
    },
    (v: ReturnType<typeof valid>) => {
      v.frames.length = 0;
    },
  ]) {
    const document = valid();
    mutate(document);
    assert.throws(
      () => parseSpatialVideoTiming(document, rate),
      (e) => e instanceof MediaProbeError && e.code === "invalid_result",
    );
  }
  for (const key of ["duration_ts", "start_pts", "nb_read_frames", "time_base", "avg_frame_rate"])
    for (const value of [undefined, null, NaN, Infinity, -1, "secret/internal/path", true]) {
      const document = valid() as unknown as { streams: Record<string, unknown>[] };
      document.streams[0]![key] = value;
      assert.throws(() => parseSpatialVideoTiming(document, rate));
    }
  for (const key of ["pts", "best_effort_timestamp", "duration"])
    for (const value of [undefined, null, NaN, Infinity, -1, 0.5]) {
      const document = valid() as unknown as { frames: Record<string, unknown>[] };
      document.frames[1]![key] = value;
      assert.throws(() => parseSpatialVideoTiming(document, rate));
    }
});

test("spatial census retains bounded output, timeout and AbortSignal cleanup", async () => {
  const work = await mkdtemp(path.join(tmpdir(), "census-bounds-"));
  try {
    const program = path.join(work, "probe.mjs");
    await writeFile(
      program,
      "#!/usr/bin/env node\nprocess.stdout.write('x'.repeat(4096));setInterval(()=>{},1000);\n",
      { mode: 0o700 },
    );
    const input = { filePath: path.join(work, "input.mp4") };
    await assert.rejects(
      new FFprobeMediaProbe({
        executable: program,
        timeoutMs: 1000,
        maxOutputBytes: 64,
      }).inspectSpatialVideoTiming(input, rate),
    );
    await writeFile(program, "#!/usr/bin/env node\nsetInterval(()=>{},1000);\n", { mode: 0o700 });
    await assert.rejects(
      new FFprobeMediaProbe({ executable: program, timeoutMs: 50 }).inspectSpatialVideoTiming(
        input,
        rate,
      ),
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      new FFprobeMediaProbe({ executable: program }).inspectSpatialVideoTiming(
        { ...input, signal: controller.signal },
        rate,
      ),
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

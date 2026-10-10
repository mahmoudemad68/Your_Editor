import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, copyFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FfmpegExecutor } from "./ffmpeg-executor.js";
import {
  FfmpegBuilder,
  audioFilterGraph,
  escapeFilterValue,
  localMediaPath,
} from "./ffmpeg-builder.js";
import { buildDerivativePreset, buildVideoPreset } from "./ffmpeg-presets.js";

test("argv snapshot and fluent builder are deterministic", () => {
  const args = FfmpegBuilder.input({ path: "/tmp/source.wav", format: "wav" })
    .output({
      format: "null",
      maps: ["0:a:0"],
      audioFilters: [{ kind: "silencedetect", noiseDb: -35, durationUs: 200000n }],
    })
    .build();
  assert.deepEqual(args, [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-loglevel",
    "info",
    "-threads",
    "2",
    "-filter_threads",
    "1",
    "-filter_complex_threads",
    "1",
    "-protocol_whitelist",
    "file",
    "-format_whitelist",
    "wav",
    "-f",
    "wav",
    "-i",
    "/tmp/source.wav",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-sn",
    "-dn",
    "-map",
    "0:a:0",
    "-vn",
    "-af",
    "silencedetect=noise=-35dB:d=0.200000",
    "-f",
    "null",
    "-",
  ]);
});
test("hostile local names remain exactly one argv value", () => {
  for (const text of [
    ":",
    ",",
    ";",
    "[",
    "]",
    "'",
    '"',
    "\\",
    "-i http://evil",
    "scale=999;anull",
    "$(touch marker)",
  ]) {
    if (text.includes("://")) {
      assert.throws(() => localMediaPath(`/tmp/${text}`));
      continue;
    }
    const file = `/tmp/${text}.wav`;
    const args = FfmpegBuilder.input({ path: file }).build();
    assert.equal(args.length, FfmpegBuilder.input({ path: "/tmp/safe.wav" }).build().length);
    assert.equal(args[args.indexOf("-i") + 1], file);
  }
});
test("protocols/options/controls and unsupported filter components fail closed", () => {
  for (const protocol of [
    "http",
    "https",
    "ftp",
    "tcp",
    "udp",
    "rtmp",
    "smb",
    "concat",
    "crypto",
    "data",
    "file",
    "pipe",
  ])
    assert.throws(() => localMediaPath(`${protocol}:input`));
  for (const file of ["-y", "relative", "/tmp/a\0b", "/tmp/a\nb", "/tmp/a\rb"])
    assert.throws(() => localMediaPath(file));
  for (const kind of ["movie", "amovie", "silencedetect;amovie", "concat"])
    assert.throws(() => audioFilterGraph([{ kind } as never]));
  for (const noiseDb of [NaN, Infinity, -Infinity, "-30;amovie=/etc/passwd"])
    assert.throws(() =>
      audioFilterGraph([{ kind: "silencedetect", noiseDb: noiseDb as number, durationUs: 1n }]),
    );
  assert.throws(() => escapeFilterValue("\n"));
});
test("filter value escaping deterministic fuzz covers all graph separators", () => {
  let seed = 220;
  const alphabet = ":,;[]'\"\\abcمرحبا-=";
  for (let i = 0; i < 1000; i++) {
    let text = "";
    for (let n = 0; n < 32; n++) {
      seed = (1664525 * seed + 1013904223) >>> 0;
      text += alphabet[seed % alphabet.length];
    }
    // Inverse both FFmpeg quoting layers: no unescaped graph delimiter remains.
    const escaped = escapeFilterValue(text);
    assert.equal(escaped.replace(/\\(.)/gs, "$1").replace(/\\(.)/gs, "$1"), text);
    assert.equal(escaped.replace(/\\./gs, "").match(/[[\],;']/), null);
  }
});
test("presets use bounded allowlisted argv and preserve US128 proxy recipe", () => {
  for (const kind of ["preview", "social1080p"] as const) {
    const args = buildVideoPreset(kind, "/tmp/in.mp4", "/tmp/out.mp4");
    assert.ok(args.includes("libx264") && args.includes("aac"));
    assert.equal(args.at(-1), "/tmp/out.mp4");
  }
  const proxy = buildDerivativePreset("/tmp/in", "/tmp/out", {
    variant: "proxy",
    parameters: { sourceDurationUs: "5000000" },
  });
  assert.equal(proxy[proxy.indexOf("-frames:v") + 1], "150");
  assert.ok(proxy.includes("4M") && proxy.includes("yuv420p"));
  assert.throws(() =>
    buildDerivativePreset("/tmp/in", "/tmp/out", {
      variant: "sprite",
      parameters: {
        sourceDurationUs: "5000000",
        timestampsUs: ["1);movie=evil"],
        columns: 1,
        rows: 1,
      },
    }),
  );
});

test("real FFmpeg hostile filenames cannot inject options, filters or shell execution", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ffmpeg-hostile-path-"));
  const marker = path.resolve(`ffmpeg-injection-${path.basename(directory)}`);
  try {
    for (const name of [
      "quote'colon:comma,semi;[a]\\.wav",
      "-y -i imaginary -af anull.wav",
      `$(touch ${path.basename(marker)}).wav`,
    ]) {
      const file = path.join(directory, name);
      await copyFile(require.resolve("../fixtures/media/audio.wav"), file);
      const args = FfmpegBuilder.input({ path: file, format: "wav" }).build();
      await new FfmpegExecutor().execute(args, { timeoutMs: 5000 });
    }
    await assert.rejects(access(marker));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

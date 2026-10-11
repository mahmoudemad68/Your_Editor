import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const digest = (b) => createHash("sha256").update(b).digest("hex");
/** Expected pixels defined analytically, before inference/render; never copied from rendered frames. */
export function solidHash(value) {
  const b = Buffer.alloc(64 * 64 * 4);
  for (let i = 0; i < b.length; i += 4) {
    b[i] = value;
    b[i + 1] = value;
    b[i + 2] = value;
    b[i + 3] = 255;
  }
  return digest(b);
}
export function framePixels(file, n) {
  return execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      file,
      "-vf",
      `select=eq(n\\,${n})`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "pipe:1",
    ],
    { maxBuffer: 64 * 64 * 4 + 1024 },
  );
}
export function verifyGoldenFrames(file, label) {
  const black = solidHash(0),
    white = solidHash(255),
    rows = [];
  const cases =
    label === "fractional-cut"
      ? [
          [0, black],
          [29, black],
          [30, white],
          [31, white],
          [59, white],
        ]
      : label === "cut-offset-gap"
        ? [
            [0, black],
            [29, black],
            [30, white],
            [31, white],
            [59, white],
            [60, black],
            [61, black],
            [89, black],
          ]
        : label === "graphics"
          ? [
              [0, white],
              [29, white],
              [30, black],
              [31, black],
            ]
          : [];
  for (const [n, expected] of cases) {
    const actual = digest(framePixels(file, n));
    assert.equal(actual, expected, `${label} frame ${n}`);
    rows.push({ frame: n, expected, actual });
  }
  if (label === "dissolve") {
    const values = [30, 32, 35].map((n) => {
      const p = framePixels(file, n);
      return p[0];
    });
    // H.264/YUV quantization affects RGB, but the six-frame opacity ramp must be visible.
    assert.ok(values[0] > 20 && values[0] < 80);
    assert.ok(values[1] > 90 && values[1] < 165);
    assert.ok(values[2] > 240);
    rows.push({ opacityProbeRgb: values });
  }
  if (label === "caption-unicode" || label === "title-safe-text") {
    const p = framePixels(file, 15);
    assert.equal(digest(framePixels(file, 30)), black, "Text interval must end at frame 30");
    assert.ok(
      p.some((v, i) => i % 4 !== 3 && v > 0),
      "Text render must contain nonblack pixels",
    );
  }
  return rows;
}

export function verifyAudioOffsets(file) {
  function measure(start) {
    const b = execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        file,
        "-ss",
        start,
        "-t",
        "0.2",
        "-ac",
        "1",
        "-ar",
        "48000",
        "-f",
        "s16le",
        "pipe:1",
      ],
      { maxBuffer: 65536 },
    );
    assert.equal(b.length, 19200);
    let crossings = 0,
      energy = 0,
      previous = 0;
    for (let i = 0; i < b.length; i += 2) {
      const x = b.readInt16LE(i);
      if (previous < 0 && x >= 0) crossings++;
      energy += (x / 32768) ** 2;
      previous = x;
    }
    return { frequencyHz: crossings / 0.2, rms: Math.sqrt(energy / (b.length / 2)) };
  }
  const first = measure("0.2"),
    second = measure("1.2"),
    gap = measure("2.2");
  assert.ok(Math.abs(first.frequencyHz - 440) <= 5);
  assert.ok(Math.abs(second.frequencyHz - 880) <= 5);
  assert.ok(gap.rms < 0.0001);
  return { first, second, gap };
}

export function verifySeparateAudioTrack(file) {
  const rms = (start) => {
    const b = execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        file,
        "-ss",
        start,
        "-t",
        "0.2",
        "-ac",
        "1",
        "-ar",
        "48000",
        "-f",
        "s16le",
        "pipe:1",
      ],
      { maxBuffer: 65536 },
    );
    let energy = 0,
      crossings = 0,
      previous = 0;
    for (let i = 0; i < b.length; i += 2) {
      const x = b.readInt16LE(i);
      energy += (x / 32768) ** 2;
      if (previous < 0 && x >= 0) crossings++;
      previous = x;
    }
    return { rms: Math.sqrt(energy / (b.length / 2)), frequencyHz: crossings / 0.2 };
  };
  const before = rms("0.2"),
    active = rms("0.7"),
    after = rms("1.7");
  assert.ok(before.rms < 0.0002 && after.rms < 0.0002);
  assert.ok(active.rms > 0.05 && Math.abs(active.frequencyHz - 880) <= 5);
  return { before, active, after };
}

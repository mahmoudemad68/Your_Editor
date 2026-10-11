import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { URL } from "node:url";

const hash = (b) => createHash("sha256").update(b).digest("hex");
const references = JSON.parse(
  readFileSync(new URL("./golden-emoji/references.json", import.meta.url)),
);
function decode(file, frame) {
  return execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      file,
      ...(frame === undefined ? [] : ["-vf", `select=eq(n\\,${frame})`]),
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "pipe:1",
    ],
    { maxBuffer: 256 * 256 * 4 },
  );
}
/** Spatial color reference independent of browser rendering. Compare normalized
 * ink bounds to the font's original embedded PNG, allowing H.264/scaling noise.
 * A white tofu box, split ZWJ glyphs or wrong emoji cannot match this reference.
 */
function signature(pixels, width, height) {
  assert.equal(pixels.length, width * height * 4);
  const rgb = (x, y, c) =>
    (pixels[(y * width + x) * 4 + c] * pixels[(y * width + x) * 4 + 3]) / 255;
  let left = width,
    right = -1,
    top = height,
    bottom = -1,
    coloredPixels = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const colors = [0, 1, 2].map((c) => rgb(x, y, c));
      if (Math.max(...colors) > 40) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
      if (Math.max(...colors) - Math.min(...colors) > 40 && Math.max(...colors) > 80)
        coloredPixels++;
    }
  assert.ok(right >= left && bottom >= top, "Glyph must have visible ink");
  const values = [];
  // Average each cell of the normalized bounding box, not a DOM assertion or
  // a golden captured from the code under test. Color + shape are both required.
  for (let gy = 0; gy < 12; gy++)
    for (let gx = 0; gx < 12; gx++) {
      const sums = [0, 0, 0];
      let count = 0;
      for (
        let y = top + Math.floor((gy * (bottom - top + 1)) / 12);
        y < top + Math.floor(((gy + 1) * (bottom - top + 1)) / 12);
        y++
      )
        for (
          let x = left + Math.floor((gx * (right - left + 1)) / 12);
          x < left + Math.floor(((gx + 1) * (right - left + 1)) / 12);
          x++
        ) {
          for (let c = 0; c < 3; c++) sums[c] += rgb(x, y, c);
          count++;
        }
      assert.ok(count > 0);
      values.push(...sums.map((v) => v / count));
    }
  return { values, coloredPixels, bounds: { left, right, top, bottom } };
}
export function verifyEmojiFrame(file, label) {
  const name = label.replace(/^emoji-(title-)?/, "").replace(/-repeat$/, "");
  const reference = references.glyphs.find((g) => g.name === name);
  assert.ok(reference, "Every emoji probe must have an independently defined glyph reference");
  const referenceFile = new URL(`./golden-emoji/${name}.png`, import.meta.url).pathname;
  const png = readFileSync(referenceFile);
  assert.equal(hash(png), reference.sha256);
  const expected = signature(decode(referenceFile), png.readUInt32BE(16), png.readUInt32BE(20));
  const pixels = decode(file, 15),
    actual = signature(pixels, 128, 128);
  const error =
    actual.values.reduce((sum, v, i) => sum + Math.abs(v - expected.values[i]), 0) /
    actual.values.length;
  assert.ok(actual.coloredPixels > 150, `${name}: colored glyph must replace monochrome tofu`);
  assert.ok(
    error < 30,
    `${name}: glyph color/shape error ${error} must match independent font bitmap`,
  );
  const end = decode(file, 30);
  assert.ok(
    end.every((v, i) => (i % 4 === 3 ? v === 255 : v === 0)),
    "Caption/title must disappear at its exact end frame",
  );
  return {
    referenceGlyph: reference.glyph,
    referenceSha256: reference.sha256,
    frame: 15,
    frameSha256: hash(pixels),
    meanColorShapeError: error,
    maximumError: 30,
    coloredPixels: actual.coloredPixels,
    bounds: actual.bounds,
    absentAtFrame: 30,
  };
}

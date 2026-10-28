import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  calibrateCaptionPaint,
  captionPaintFraction,
  captionEncodedPaintFraction,
} from "../../tools/render/caption-paint-metric.mjs";

// Constructed RGB/codec observations, not natural speech or annotation accuracy.
const image = (indices) => {
  const rgb = Buffer.alloc(20 * 3, 255);
  for (const i of indices) rgb[i * 3 + 2] = 0;
  return rgb;
};
test("codec calibration is independent of output and rejects missing or wrong-word paint", () => {
  const native = image([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    encoded = image([0, 1, 2, 3, 4, 5]),
    inactive = image([12, 13, 14, 15, 16, 17]),
    { rawMask, mask, negativeFraction } = calibrateCaptionPaint(native, encoded, inactive);
  assert.equal(captionPaintFraction(encoded, rawMask), 0.6);
  assert.deepEqual(mask, [0, 1, 2, 3, 4, 5]);
  assert.equal(captionPaintFraction(encoded, mask), 1);
  assert.equal(negativeFraction, 0);
  assert.equal(captionPaintFraction(image([]), mask), 0);
  assert.equal(captionPaintFraction(inactive, mask), 0);
  assert.ok(captionPaintFraction(image([0, 1, 2]), mask) < 0.7);
  assert.ok(captionPaintFraction(image([0, 1, 2, 3, 4]), mask) >= 0.7);
});

test("codec paint decisions preserve chroma under luma changes, without accepting empty or wrong colors", () => {
  const native = image([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const solid = (color) => Buffer.from(Array.from({ length: 20 }, () => color).flat());
  const positive = solid([185, 190, 90]),
    negative = solid([240, 240, 240]),
    faded = solid([145, 150, 50]),
    calibration = calibrateCaptionPaint(native, positive, negative);
  assert.equal(captionPaintFraction(faded, calibration.mask), 0);
  assert.equal(captionEncodedPaintFraction(faded, calibration), 1);
  for (const color of [
    [0, 0, 0],
    [255, 255, 255],
    [128, 128, 128],
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
  ]) {
    assert.equal(captionEncodedPaintFraction(solid(color), calibration), 0);
  }
  const partial = Buffer.from(negative);
  for (let i = 0; i < 6; i++) partial.set([145, 150, 50], i * 3);
  assert.equal(captionEncodedPaintFraction(partial, calibration), 0.6);
  assert.throws(() => captionEncodedPaintFraction(new Uint8Array(3), calibration));
  assert.throws(() =>
    captionEncodedPaintFraction(faded, { ...calibration, positive: solid([0, 0, 255]) }),
  );
});
test("unmeasurable, inconsistent and persistently highlighted controls fail closed", () => {
  const native = image([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    encoded = image([0, 1, 2, 3, 4, 5]),
    inactive = image([]);
  assert.throws(() => calibrateCaptionPaint(native, image([]), inactive));
  assert.throws(() => calibrateCaptionPaint(native, image([0, 1, 2, 3]), inactive));
  assert.throws(() => calibrateCaptionPaint(image([]), encoded, inactive));
  assert.throws(() => calibrateCaptionPaint(native, encoded, encoded));
  assert.throws(() => calibrateCaptionPaint(native, encoded.subarray(3), inactive));
  assert.throws(() => captionPaintFraction(encoded, [0, 1, 2, 3, 20]));
  assert.throws(() => captionPaintFraction(encoded, [0, 1, 2, 3, 3]));
  assert.throws(() => captionPaintFraction(encoded, [0, 1, 2, 3, 4.5]));
  assert.throws(() => captionPaintFraction(new Uint8Array(2), [0, 1, 2, 3, 4]));
});

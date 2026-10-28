import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  calibrateCaptionPaint,
  captionPaintFraction,
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

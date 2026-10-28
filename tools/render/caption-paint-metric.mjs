import assert from "node:assert/strict";

const yellow = (rgb, i) => rgb[i * 3] > 180 && rgb[i * 3 + 1] > 180 && rgb[i * 3 + 2] < 100;
function pixels(rgb) {
  assert.ok(rgb instanceof Uint8Array && rgb.length > 0 && rgb.length % 3 === 0);
  return rgb.length / 3;
}

export function captionPaintFraction(rgb, mask) {
  const count = pixels(rgb);
  assert.ok(mask.length > 4, "Caption paint has too few measurable pixels");
  assert.equal(new Set(mask).size, mask.length);
  assert.ok(mask.every((i) => Number.isSafeInteger(i) && i >= 0 && i < count));
  return mask.filter((i) => yellow(rgb, i)).length / mask.length;
}

/** The output is H.264/yuv420p, not lossless RGB. Keep only native-word pixels
 * whose active color the same codec profile can actually preserve. Never select
 * coordinates from the actual output being evaluated. Both raw and calibrated
 * results remain reportable. An independently rendered native end-frame is a
 * mandatory negative control, preventing persistent/wrong-word paint acceptance.
 */
export function calibrateCaptionPaint(nativeRgb, codecRgb, inactiveCodecRgb) {
  const count = pixels(nativeRgb);
  assert.equal(pixels(codecRgb), count);
  assert.equal(pixels(inactiveCodecRgb), count);
  const rawMask = [],
    mask = [];
  for (let i = 0; i < count; i++) {
    if (!yellow(nativeRgb, i)) continue;
    rawMask.push(i);
    if (yellow(codecRgb, i)) mask.push(i);
  }
  assert.ok(rawMask.length > 4, "Native active-word reference has no visible pixels");
  assert.ok(mask.length > 4, "Codec cannot preserve measurable native-word paint");
  assert.equal(captionPaintFraction(codecRgb, mask), 1);
  const negativeFraction = captionPaintFraction(inactiveCodecRgb, mask);
  assert.ok(negativeFraction <= 0.2, "Native end-frame retained the target word highlight");
  return { rawMask, mask, negativeFraction };
}

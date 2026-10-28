import assert from "node:assert/strict";

const yellow = (rgb, i) => rgb[i * 3] > 180 && rgb[i * 3 + 1] > 180 && rgb[i * 3 + 2] < 100;
const chroma = (rgb, i, channel) => rgb[i * 3 + channel] - rgb[i * 3 + 2];
// Same visible-signal floor as the independent glyph/safe-zone frame proof.
const visible = (rgb, i) => Math.max(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]) > 32;
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

/** Two-channel nearest-control decision in yellow chroma, not absolute luma.
 * Neutral black/white and either red/green alone cannot satisfy both channels.
 * The decision boundary is the midpoint of independent codec controls; it is
 * never fitted to the output under evaluation or to a desired passing score.
 */
export function captionEncodedPaintFraction(rgb, calibration) {
  assert.equal(pixels(rgb), pixels(calibration.positive));
  assert.equal(pixels(rgb), pixels(calibration.negative));
  const { mask, positive, negative } = calibration;
  captionPaintFraction(rgb, mask); // Bounds and uniqueness remain mandatory.
  assert.ok(
    mask.every((i) =>
      [0, 1].every(
        (channel) =>
          visible(positive, i) &&
          chroma(positive, i, channel) > Math.max(0, chroma(negative, i, channel)),
      ),
    ),
    "Codec controls do not separate active and inactive paint",
  );
  return (
    mask.filter((i) =>
      [0, 1].every(
        (channel) =>
          visible(rgb, i) &&
          chroma(rgb, i, channel) >
            (chroma(positive, i, channel) + Math.max(0, chroma(negative, i, channel))) / 2,
      ),
    ).length / mask.length
  );
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
    if (
      visible(codecRgb, i) &&
      [0, 1].every(
        (channel) =>
          chroma(codecRgb, i, channel) > Math.max(0, chroma(inactiveCodecRgb, i, channel)),
      )
    )
      mask.push(i);
  }
  assert.ok(rawMask.length > 4, "Native active-word reference has no visible pixels");
  assert.ok(mask.length > 4, "Codec cannot preserve measurable native-word paint");
  const calibration = { rawMask, mask, positive: codecRgb, negative: inactiveCodecRgb };
  assert.equal(captionEncodedPaintFraction(codecRgb, calibration), 1);
  const negativeFraction = captionEncodedPaintFraction(inactiveCodecRgb, calibration);
  assert.ok(negativeFraction <= 0.2, "Native end-frame retained the target word highlight");
  return { ...calibration, negativeFraction };
}

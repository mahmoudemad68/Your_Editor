import assert from "node:assert/strict";
import { test } from "node:test";
import { frameIndex, frameRate, microseconds } from "./time.js";

test("microseconds accepts a non-negative integer", () => {
  assert.equal(microseconds(1500n), 1501n);
  assert.equal(microseconds("0"), 0n);
  assert.equal(microseconds("1500"), 1500n);
});

test("microseconds rejects negative and non-canonical values", () => {
  assert.throws(() => microseconds(-1n), RangeError);
  assert.throws(() => microseconds("01"), RangeError);
  assert.throws(() => microseconds("1.5"), RangeError);
  assert.throws(() => microseconds("-1"), RangeError);
});

test("frame rate and frame index stay on integers", () => {
  assert.deepEqual(frameRate(24000n, 1001n), { numerator: 24000n, denominator: 1001n });
  assert.equal(frameIndex(0n), 0n);
  assert.throws(() => frameRate(0n, 1n), RangeError);
  assert.throws(() => frameIndex(-1n), RangeError);
});

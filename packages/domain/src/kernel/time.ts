/**
 * Media time as integer microseconds and integer frames (ADR-008).
 * JSON encodes these as canonical decimal strings. See packages/schemas.
 */

const CANONICAL_INTEGER = /^(0|[1-9][0-9]*)$/;

export type Microseconds = bigint;
export type FrameIndex = bigint;

export interface FrameRate {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export function microseconds(value: bigint | string): Microseconds {
  const parsed = typeof value === "bigint" ? value : parseCanonicalInteger(value);
  if (parsed < 0n) {
    throw new RangeError("Media time must be a non-negative integer number of microseconds.");
  }
  return parsed;
}

export function frameIndex(value: bigint): FrameIndex {
  if (typeof value !== "bigint" || value < 0n) {
    throw new RangeError("Frame index must be a non-negative integer.");
  }
  return value;
}

export function frameRate(numerator: bigint, denominator: bigint): FrameRate {
  if (
    typeof numerator !== "bigint" ||
    typeof denominator !== "bigint" ||
    numerator <= 0n ||
    denominator <= 0n
  ) {
    throw new RangeError("Frame rate numerator and denominator must be positive integers.");
  }
  return Object.freeze({ numerator, denominator });
}

function parseCanonicalInteger(value: string): bigint {
  if (typeof value !== "string" || !CANONICAL_INTEGER.test(value)) {
    throw new RangeError("Media time must be a canonical decimal integer string.");
  }
  return BigInt(value);
}

/** Round nonnegative rationals half up. Compute from the absolute frame index, never accumulated durations. */
function rounded(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator);
}

export function frameTime(index: FrameIndex, rate: FrameRate): Microseconds {
  const fps = frameRate(rate.numerator, rate.denominator);
  return rounded(frameIndex(index) * 1000000n * fps.denominator, fps.numerator);
}

export function snapToFrame(time: Microseconds | string, rate: FrameRate): Microseconds {
  const fps = frameRate(rate.numerator, rate.denominator);
  const index = rounded(microseconds(time) * fps.numerator, 1000000n * fps.denominator);
  return frameTime(index, fps);
}

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
  if (value < 0n) {
    throw new RangeError("Frame index must be a non-negative integer.");
  }
  return value;
}

export function frameRate(numerator: bigint, denominator: bigint): FrameRate {
  if (numerator <= 0n || denominator <= 0n) {
    throw new RangeError("Frame rate numerator and denominator must be positive integers.");
  }
  return { numerator, denominator };
}

function parseCanonicalInteger(value: string): bigint {
  if (!CANONICAL_INTEGER.test(value)) {
    throw new RangeError("Media time must be a canonical decimal integer string.");
  }
  return BigInt(value);
}

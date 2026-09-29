# ADR-008 — Time representation as integer microseconds and frames

- **Status:** Accepted
- **Date:** 2026-09-29
- **Accepted:** 2026-09-29
- **Acceptance vehicle:** PR #2
- **Approved by:** project team / product owner

## Context

Edits, captions, silence ranges, and render ranges all refer to positions on a timeline. Floating-point seconds drift: a cut computed in IEEE-754 cannot be replayed bit-for-bit, and a timestamp that survives a trip through JSON numbers can change. Frame-accurate work needs an integer position and a rational frame rate.

The shared kernel has to state this before Editing, Analysis, and Rendering each invent a unit.

## Decision

- A media position is a non-negative **integer number of microseconds** from the start of the timeline.
- A frame position is a non-negative **integer frame index**.
- A frame rate is a rational pair of positive integers: `numerator / denominator`. Conversion between frames and microseconds uses that ratio and integer arithmetic. It does not use a binary floating-point frame duration.
- In TypeScript the in-process types are `bigint`. In Python they are `int`.
- In JSON the value is a canonical decimal string matching `^(0|[1-9][0-9]*)$`, defined by `packages/schemas/src/media-time.schema.json`. JSON numbers are not used for media time, because a JSON number is a float in JavaScript.
- The domain kernel (`packages/domain/src/kernel/time.ts`) is the TypeScript constructor for these values. Callers outside the kernel do not perform ad-hoc arithmetic on raw `number` timestamps for timeline positions.

Durations use the same microsecond integer. Wall-clock timestamps for logs and audit columns are not media time and are not covered by this decision.

## Rationale

Microseconds are fine enough for sample-accurate audio math and still exact as integers. Frame index plus a rational rate matches how containers describe frame rates (24000/1001, 30000/1001, 25/1). `bigint` and Python `int` cannot silently become `0.30000000000000004`. A string in JSON keeps the value exact on both sides of ADR-003.

## Consequences

- The scaffold includes the kernel constructors and the JSON Schema. It does not include a timeline model (US-214) or a probe implementation (US-126).
- Libraries that return floating seconds are converted at the adapter boundary (media-core, the AI worker). The converted integer is what the domain stores.
- Display code may format a position as `HH:MM:SS.mmm`. That string is a view, not the stored value.
- Integer overflow is not a practical concern for the MVP duration cap (30 minutes). The types still reject negative values.

## Alternatives considered

- **Floating-point seconds.** Rejected. Addition of frame durations is not exact, and cuts would depend on the language runtime.
- **Integer milliseconds only.** Rejected. Milliseconds are coarser than a video frame at high frame rates and coarser than audio sample alignment.
- **Integer frame index as the only unit.** Rejected as the only unit. Audio and silence ranges are not naturally frames, and two assets in one timeline can have different rates. Microseconds are the common unit. Frame index remains available beside it.
- **JSON numbers for microsecond integers.** Rejected. Values above `2^53 - 1` are not exact in JavaScript `JSON.parse`, and smaller values are still the wrong type once any consumer treats them as floats.

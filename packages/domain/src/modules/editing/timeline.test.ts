import assert from "node:assert/strict";
import { test } from "node:test";
import { instant } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import { clipId, projectId, timelineId, trackId } from "../../kernel/id.js";
import { Clip, Effect, Timeline, Track } from "./timeline.js";

test("canonical editing types reject a non-positive clip range and floating time", () => {
  const timeline = Timeline.create(
    timelineId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f"),
    projectId("018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f"),
    instant(0n),
  );
  const track = Track.create(trackId("018f6b6e-7c3a-7222-8d3e-9c0b1a2d3e4f"), timeline.id);
  const clip = Clip.create(clipId("018f6b6e-7c3a-7333-8d3e-9c0b1a2d3e4f"), track.id, 0n, 1500n);
  assert.equal(clip.inPoint, 0n);
  assert.equal(clip.outPoint, 1500n);
  assert.equal(Timeline.name, "Timeline");
  assert.equal(Track.name, "Track");
  assert.equal(Clip.name, "Clip");
  assert.equal(Effect.name, "Effect");
  assert.throws(() => Clip.create(clip.id, track.id, 10n, 10n), DomainError);
  assert.throws(() => Clip.create(clip.id, track.id, "1.5", 2n), RangeError);
});

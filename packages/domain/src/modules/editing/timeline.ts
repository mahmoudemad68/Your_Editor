/**
 * Canonical Editing names. Command application, undo, and the timeline UI are later stories.
 * Positions are integer microseconds (ADR-008). There is no floating-point timeline time.
 * Constructors validate their own arguments so a JavaScript caller cannot skip the factory.
 */

import { type Instant, instant } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import {
  type ClipId,
  clipId,
  type EffectId,
  effectId,
  type ProjectId,
  projectId,
  type TimelineId,
  timelineId,
  type TrackId,
  trackId,
} from "../../kernel/id.js";
import { microseconds, type Microseconds } from "../../kernel/time.js";

export class Timeline {
  readonly id: TimelineId;
  readonly projectId: ProjectId;
  readonly createdAt: Instant;

  constructor(
    id: TimelineId | string,
    projectIdValue: ProjectId | string,
    createdAt: Instant | string | bigint,
  ) {
    this.id = timelineId(String(id));
    this.projectId = projectId(String(projectIdValue));
    this.createdAt = instant(createdAt);
    Object.freeze(this);
  }

  static create(id: TimelineId, projectIdValue: ProjectId, createdAt: Instant): Timeline {
    return new Timeline(id, projectIdValue, createdAt);
  }
}

export class Track {
  readonly id: TrackId;
  readonly timelineId: TimelineId;

  constructor(id: TrackId | string, timelineIdValue: TimelineId | string) {
    this.id = trackId(String(id));
    this.timelineId = timelineId(String(timelineIdValue));
    Object.freeze(this);
  }

  static create(id: TrackId, timelineIdValue: TimelineId): Track {
    return new Track(id, timelineIdValue);
  }
}

export class Clip {
  readonly id: ClipId;
  readonly trackId: TrackId;
  readonly inPoint: Microseconds;
  readonly outPoint: Microseconds;

  constructor(
    id: ClipId | string,
    trackIdValue: TrackId | string,
    inPoint: Microseconds | bigint | string,
    outPoint: Microseconds | bigint | string,
  ) {
    const start = microseconds(inPoint);
    const end = microseconds(outPoint);
    if (end <= start) {
      throw new DomainError(
        "Clip out-point must be greater than its in-point, in integer microseconds.",
      );
    }
    this.id = clipId(String(id));
    this.trackId = trackId(String(trackIdValue));
    this.inPoint = start;
    this.outPoint = end;
    Object.freeze(this);
  }

  static create(
    id: ClipId,
    trackIdValue: TrackId,
    inPoint: bigint | string,
    outPoint: bigint | string,
  ): Clip {
    return new Clip(id, trackIdValue, inPoint, outPoint);
  }
}

export class Effect {
  readonly id: EffectId;
  readonly clipId: ClipId;

  constructor(id: EffectId | string, clipIdValue: ClipId | string) {
    this.id = effectId(String(id));
    this.clipId = clipId(String(clipIdValue));
    Object.freeze(this);
  }

  static create(id: EffectId, clipIdValue: ClipId): Effect {
    return new Effect(id, clipIdValue);
  }
}

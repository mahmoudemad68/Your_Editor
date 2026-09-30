/**
 * Canonical Editing names. Command application, undo, and the timeline UI are later stories.
 * Positions are integer microseconds (ADR-008). There is no floating-point timeline time.
 */

import { type Instant, instant } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import {
  type ClipId,
  type EffectId,
  type ProjectId,
  type TimelineId,
  type TrackId,
} from "../../kernel/id.js";
import { microseconds, type Microseconds } from "../../kernel/time.js";

export class Timeline {
  readonly id: TimelineId;
  readonly projectId: ProjectId;
  readonly createdAt: Instant;

  private constructor(id: TimelineId, projectId: ProjectId, createdAt: Instant) {
    this.id = id;
    this.projectId = projectId;
    this.createdAt = createdAt;
  }

  static create(id: TimelineId, projectId: ProjectId, createdAt: Instant): Timeline {
    return new Timeline(id, projectId, instant(createdAt));
  }
}

export class Track {
  readonly id: TrackId;
  readonly timelineId: TimelineId;

  private constructor(id: TrackId, timelineId: TimelineId) {
    this.id = id;
    this.timelineId = timelineId;
  }

  static create(id: TrackId, timelineId: TimelineId): Track {
    return new Track(id, timelineId);
  }
}

export class Clip {
  readonly id: ClipId;
  readonly trackId: TrackId;
  readonly inPoint: Microseconds;
  readonly outPoint: Microseconds;

  private constructor(id: ClipId, trackId: TrackId, inPoint: Microseconds, outPoint: Microseconds) {
    this.id = id;
    this.trackId = trackId;
    this.inPoint = inPoint;
    this.outPoint = outPoint;
  }

  static create(
    id: ClipId,
    trackId: TrackId,
    inPoint: bigint | string,
    outPoint: bigint | string,
  ): Clip {
    const start = microseconds(inPoint);
    const end = microseconds(outPoint);
    if (end <= start) {
      throw new DomainError(
        "Clip out-point must be greater than its in-point, in integer microseconds.",
      );
    }
    return new Clip(id, trackId, start, end);
  }
}

export class Effect {
  readonly id: EffectId;
  readonly clipId: ClipId;

  private constructor(id: EffectId, clipId: ClipId) {
    this.id = id;
    this.clipId = clipId;
  }

  static create(id: EffectId, clipId: ClipId): Effect {
    return new Effect(id, clipId);
  }
}

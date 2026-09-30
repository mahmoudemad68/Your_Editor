/**
 * Media aggregate. Video, Audio, and Image are subtypes of MediaAsset.
 * Inspection and upload behavior belong to later Media stories.
 */

import { type Instant, instant } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import { type MediaAssetId, type ProjectId } from "../../kernel/id.js";
import { microseconds, type Microseconds } from "../../kernel/time.js";

/** 30 minutes. Exactly this value is accepted. One microsecond more is rejected. */
export const MAX_MEDIA_DURATION: Microseconds = 1_800_000_000n;

export type MediaKind = "video" | "audio" | "image";

export class MediaAsset {
  readonly id: MediaAssetId;
  readonly projectId: ProjectId;
  readonly kind: MediaKind;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly duration: Microseconds | null;

  protected constructor(
    id: MediaAssetId,
    projectId: ProjectId,
    kind: MediaKind,
    createdAt: Instant,
    duration: Microseconds | null,
  ) {
    this.id = id;
    this.projectId = projectId;
    this.kind = kind;
    this.createdAt = createdAt;
    this.updatedAt = createdAt;
    this.duration = duration;
  }

  static create(input: {
    readonly id: MediaAssetId;
    readonly projectId: ProjectId;
    readonly kind: string;
    readonly createdAt: Instant;
    readonly duration?: bigint | string | null;
  }): Video | Audio | Image {
    const kind = mediaKind(input.kind);
    const stamp = instant(input.createdAt);
    const duration = input.duration == null ? null : mediaDuration(input.duration);
    if (kind === "video") {
      return new Video(input.id, input.projectId, stamp, duration);
    }
    if (kind === "audio") {
      return new Audio(input.id, input.projectId, stamp, duration);
    }
    return new Image(input.id, input.projectId, stamp, duration);
  }
}

export class Video extends MediaAsset {
  override readonly kind = "video" as const;

  constructor(
    id: MediaAssetId,
    projectId: ProjectId,
    createdAt: Instant,
    duration: Microseconds | null,
  ) {
    super(id, projectId, "video", createdAt, duration);
  }
}

export class Audio extends MediaAsset {
  override readonly kind = "audio" as const;

  constructor(
    id: MediaAssetId,
    projectId: ProjectId,
    createdAt: Instant,
    duration: Microseconds | null,
  ) {
    super(id, projectId, "audio", createdAt, duration);
  }
}

export class Image extends MediaAsset {
  override readonly kind = "image" as const;

  constructor(
    id: MediaAssetId,
    projectId: ProjectId,
    createdAt: Instant,
    duration: Microseconds | null,
  ) {
    super(id, projectId, "image", createdAt, duration);
  }
}

export function mediaKind(value: string): MediaKind {
  if (value === "video" || value === "audio" || value === "image") {
    return value;
  }
  throw new DomainError("MediaAsset kind must be video, audio, or image.");
}

export function mediaDuration(value: bigint | string): Microseconds {
  const duration = microseconds(value);
  if (duration > MAX_MEDIA_DURATION) {
    throw new DomainError("MediaAsset duration must be at most 1,800,000,000 microseconds.");
  }
  return duration;
}

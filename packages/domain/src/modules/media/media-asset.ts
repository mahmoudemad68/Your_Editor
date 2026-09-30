/**
 * Media aggregate. Video, Audio, and Image are subtypes of MediaAsset.
 * Every constructor validates duration and timestamps. Inspection and upload
 * behavior belong to later Media stories.
 */

import { type Instant, instant } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import { mediaAssetId, type MediaAssetId, projectId, type ProjectId } from "../../kernel/id.js";
import { microseconds, type Microseconds } from "../../kernel/time.js";

/** 30 minutes. Exactly this value is accepted. One microsecond more is rejected. */
export const MAX_MEDIA_DURATION: Microseconds = 1_800_000_000n;

export type MediaKind = "video" | "audio" | "image";

export interface MediaAssetSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly kind: string;
  readonly duration: bigint | string | null;
  readonly createdAt: bigint | string;
  readonly updatedAt: bigint | string;
}

export class MediaAsset {
  readonly id: MediaAssetId;
  readonly projectId: ProjectId;
  readonly kind: MediaKind;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly duration: Microseconds | null;

  protected constructor(
    id: MediaAssetId | string,
    projectIdValue: ProjectId | string,
    kind: string,
    createdAt: Instant | string | bigint,
    duration: Microseconds | bigint | string | null,
    updatedAt?: Instant | string | bigint,
  ) {
    const created = instant(createdAt);
    const updated = updatedAt == null ? created : instant(updatedAt);
    this.id = mediaAssetId(String(id));
    this.projectId = projectId(String(projectIdValue));
    this.kind = mediaKind(kind);
    this.createdAt = created;
    this.updatedAt = updated;
    this.duration = duration == null ? null : mediaDuration(duration);
    if (new.target === MediaAsset) {
      Object.freeze(this);
    }
  }

  static create(input: {
    readonly id: MediaAssetId;
    readonly projectId: ProjectId;
    readonly kind: string;
    readonly createdAt: Instant;
    readonly duration?: bigint | string | null;
  }): Video | Audio | Image {
    return MediaAsset.restore({
      id: input.id,
      projectId: input.projectId,
      kind: input.kind,
      duration: input.duration ?? null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
  }

  /** Rebuild a persisted MediaAsset. Does not replay upload or inspection. */
  static restore(snapshot: MediaAssetSnapshot): Video | Audio | Image {
    const kind = mediaKind(snapshot.kind);
    if (kind === "video") {
      return new Video(
        snapshot.id,
        snapshot.projectId,
        snapshot.createdAt,
        snapshot.duration,
        snapshot.updatedAt,
      );
    }
    if (kind === "audio") {
      return new Audio(
        snapshot.id,
        snapshot.projectId,
        snapshot.createdAt,
        snapshot.duration,
        snapshot.updatedAt,
      );
    }
    return new Image(
      snapshot.id,
      snapshot.projectId,
      snapshot.createdAt,
      snapshot.duration,
      snapshot.updatedAt,
    );
  }

  toSnapshot(): MediaAssetSnapshot {
    return {
      id: this.id,
      projectId: this.projectId,
      kind: this.kind,
      duration: this.duration,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

export class Video extends MediaAsset {
  override readonly kind = "video" as const;

  constructor(
    id: MediaAssetId | string,
    projectIdValue: ProjectId | string,
    createdAt: Instant | string | bigint,
    duration: Microseconds | bigint | string | null,
    updatedAt?: Instant | string | bigint,
  ) {
    super(id, projectIdValue, "video", createdAt, duration, updatedAt);
    Object.freeze(this);
  }
}

export class Audio extends MediaAsset {
  override readonly kind = "audio" as const;

  constructor(
    id: MediaAssetId | string,
    projectIdValue: ProjectId | string,
    createdAt: Instant | string | bigint,
    duration: Microseconds | bigint | string | null,
    updatedAt?: Instant | string | bigint,
  ) {
    super(id, projectIdValue, "audio", createdAt, duration, updatedAt);
    Object.freeze(this);
  }
}

export class Image extends MediaAsset {
  override readonly kind = "image" as const;

  constructor(
    id: MediaAssetId | string,
    projectIdValue: ProjectId | string,
    createdAt: Instant | string | bigint,
    duration: Microseconds | bigint | string | null,
    updatedAt?: Instant | string | bigint,
  ) {
    super(id, projectIdValue, "image", createdAt, duration, updatedAt);
    Object.freeze(this);
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

/**
 * Media aggregate. Video, Audio, and Image are subtypes of MediaAsset.
 * Every constructor validates duration and timestamps. Inspection and upload
 * behavior belong to later Media stories.
 */

import { type Instant, instant, requireAuditOrder } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import { mediaAssetId, type MediaAssetId, projectId, type ProjectId } from "../../kernel/id.js";
import { microseconds, type Microseconds } from "../../kernel/time.js";
import {
  assertMediaStorageKey,
  contentSha256,
  displayFilename,
  mediaByteSize,
  mediaStorageKey,
  videoMimeType,
} from "./media-upload.js";

/** 30 minutes. Exactly this value is accepted. One microsecond more is rejected. */
export const MAX_MEDIA_DURATION: Microseconds = 1_800_000_000n;

export type MediaKind = "video" | "audio" | "image";

export interface MediaUploadMetadata {
  readonly storageKey: string;
  readonly displayFilename: string;
  readonly mimeType: string;
  readonly byteSize: bigint | string;
  readonly contentSha256: string;
  readonly uploadState: string;
}

export interface MediaAssetSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly kind: string;
  readonly duration: bigint | string | null;
  readonly createdAt: bigint | string;
  readonly updatedAt: bigint | string;
  readonly storageKey?: string | null;
  readonly displayFilename?: string | null;
  readonly mimeType?: string | null;
  readonly byteSize?: bigint | string | null;
  readonly contentSha256?: string | null;
  readonly uploadState?: string | null;
}

export class MediaAsset {
  readonly id: MediaAssetId;
  readonly projectId: ProjectId;
  readonly kind: MediaKind;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly duration: Microseconds | null;
  readonly storageKey: string | null;
  readonly displayFilename: string | null;
  readonly mimeType: string | null;
  readonly byteSize: bigint | null;
  readonly contentSha256: string | null;
  readonly uploadState: "uploaded" | null;

  protected constructor(
    id: MediaAssetId | string,
    projectIdValue: ProjectId | string,
    kind: string,
    createdAt: Instant | string | bigint,
    duration: Microseconds | bigint | string | null,
    updatedAt?: Instant | string | bigint,
    upload?: MediaUploadMetadata | null,
  ) {
    const created = instant(createdAt);
    const updated = updatedAt == null ? created : instant(updatedAt);
    this.id = mediaAssetId(String(id));
    this.projectId = projectId(String(projectIdValue));
    this.kind = mediaKind(kind);
    this.createdAt = created;
    this.updatedAt = updated;
    requireAuditOrder(this.createdAt, this.updatedAt);
    this.duration = duration == null ? null : mediaDuration(duration);
    const recorded = upload == null ? null : sealUpload(this.projectId, upload);
    this.storageKey = recorded?.storageKey ?? null;
    this.displayFilename = recorded?.displayFilename ?? null;
    this.mimeType = recorded?.mimeType ?? null;
    this.byteSize = recorded?.byteSize ?? null;
    this.contentSha256 = recorded?.contentSha256 ?? null;
    this.uploadState = recorded?.uploadState ?? null;
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

  /**
   * A completed direct upload. Duration stays null until technical inspection.
   * The storage key is derived here and does not accept a caller path.
   */
  static createUploaded(input: {
    readonly id: MediaAssetId;
    readonly projectId: ProjectId;
    readonly createdAt: Instant;
    readonly displayFilename: string;
    readonly mimeType: string;
    readonly byteSize: bigint | number | string;
    readonly contentSha256: string;
  }): Video {
    const hash = contentSha256(input.contentSha256);
    const restored = MediaAsset.restore({
      id: input.id,
      projectId: input.projectId,
      kind: "video",
      duration: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      storageKey: mediaStorageKey(input.projectId, hash),
      displayFilename: input.displayFilename,
      mimeType: input.mimeType,
      byteSize: mediaByteSize(input.byteSize),
      contentSha256: hash,
      uploadState: "uploaded",
    });
    if (!(restored instanceof Video)) {
      throw new DomainError("An uploaded MediaAsset is a video.");
    }
    return restored;
  }

  /** Rebuild a persisted MediaAsset. Does not replay upload or inspection. */
  static restore(snapshot: MediaAssetSnapshot): Video | Audio | Image {
    const kind = mediaKind(snapshot.kind);
    const upload = uploadFromSnapshot(snapshot);
    if (kind === "video") {
      return new Video(
        snapshot.id,
        snapshot.projectId,
        snapshot.createdAt,
        snapshot.duration,
        snapshot.updatedAt,
        upload,
      );
    }
    if (kind === "audio") {
      return new Audio(
        snapshot.id,
        snapshot.projectId,
        snapshot.createdAt,
        snapshot.duration,
        snapshot.updatedAt,
        upload,
      );
    }
    return new Image(
      snapshot.id,
      snapshot.projectId,
      snapshot.createdAt,
      snapshot.duration,
      snapshot.updatedAt,
      upload,
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
      storageKey: this.storageKey,
      displayFilename: this.displayFilename,
      mimeType: this.mimeType,
      byteSize: this.byteSize,
      contentSha256: this.contentSha256,
      uploadState: this.uploadState,
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
    upload?: MediaUploadMetadata | null,
  ) {
    super(id, projectIdValue, "video", createdAt, duration, updatedAt, upload);
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
    upload?: MediaUploadMetadata | null,
  ) {
    super(id, projectIdValue, "audio", createdAt, duration, updatedAt, upload);
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
    upload?: MediaUploadMetadata | null,
  ) {
    super(id, projectIdValue, "image", createdAt, duration, updatedAt, upload);
    Object.freeze(this);
  }
}

export function mediaKind(value: string): MediaKind {
  if (value === "video" || value === "audio" || value === "image") {
    return value;
  }
  throw new DomainError("MediaAsset kind must be video, audio, or image.");
}

function sealUpload(
  ownerProjectId: ProjectId,
  upload: MediaUploadMetadata,
): {
  storageKey: string;
  displayFilename: string;
  mimeType: string;
  byteSize: bigint;
  contentSha256: string;
  uploadState: "uploaded";
} {
  if (upload.uploadState !== "uploaded") {
    throw new DomainError("MediaAsset upload state must be uploaded.");
  }
  const hash = contentSha256(upload.contentSha256);
  return {
    storageKey: assertMediaStorageKey(ownerProjectId, hash, upload.storageKey),
    displayFilename: displayFilename(upload.displayFilename),
    mimeType: videoMimeType(upload.mimeType),
    byteSize: mediaByteSize(upload.byteSize),
    contentSha256: hash,
    uploadState: "uploaded",
  };
}

function uploadFromSnapshot(snapshot: MediaAssetSnapshot): MediaUploadMetadata | null {
  const present = [
    snapshot.storageKey,
    snapshot.displayFilename,
    snapshot.mimeType,
    snapshot.byteSize,
    snapshot.contentSha256,
    snapshot.uploadState,
  ];
  const filled = present.filter((value) => value != null);
  if (filled.length === 0) {
    return null;
  }
  if (
    filled.length !== present.length ||
    snapshot.storageKey == null ||
    snapshot.displayFilename == null ||
    snapshot.mimeType == null ||
    snapshot.byteSize == null ||
    snapshot.contentSha256 == null ||
    snapshot.uploadState == null
  ) {
    throw new DomainError("MediaAsset upload metadata must be stored together.");
  }
  return {
    storageKey: snapshot.storageKey,
    displayFilename: snapshot.displayFilename,
    mimeType: snapshot.mimeType,
    byteSize: snapshot.byteSize,
    contentSha256: snapshot.contentSha256,
    uploadState: snapshot.uploadState,
  };
}

export function mediaDuration(value: bigint | string): Microseconds {
  const duration = microseconds(value);
  if (duration > MAX_MEDIA_DURATION) {
    throw new DomainError("MediaAsset duration must be at most 1,800,000,000 microseconds.");
  }
  return duration;
}

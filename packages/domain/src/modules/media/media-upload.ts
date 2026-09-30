import { DomainError } from "../../kernel/error.js";
import { type ProjectId, projectId } from "../../kernel/id.js";

/** 4 GiB. Exactly this size is accepted. One byte more is rejected. */
export const MAX_MEDIA_BYTES = 4n * 1024n * 1024n * 1024n;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const DISPLAY_NAME_LIMIT = 255;

const VIDEO_MIME_TYPES = {
  "video/mp4": "MP4",
  "video/quicktime": "MOV",
  "video/x-matroska": "MKV",
  "video/webm": "WebM",
} as const;

export type VideoMimeType = keyof typeof VIDEO_MIME_TYPES;

export function contentSha256(value: string): string {
  if (!SHA256_HEX.test(value)) {
    throw new DomainError("SHA-256 must be 64 lowercase hexadecimal characters.");
  }
  return value;
}

export function videoMimeType(value: string): VideoMimeType {
  if (Object.prototype.hasOwnProperty.call(VIDEO_MIME_TYPES, value)) {
    return value as VideoMimeType;
  }
  throw new DomainError(
    "Media MIME type must be video/mp4, video/quicktime, video/x-matroska, or video/webm.",
  );
}

export function mediaByteSize(value: bigint | number | string): bigint {
  const size = typeof value === "bigint" ? value : parseByteSize(value);
  if (size < 1n || size > MAX_MEDIA_BYTES) {
    throw new DomainError("Media byte size must be from 1 byte through 4 GiB.");
  }
  return size;
}

export function displayFilename(value: string): string {
  if (value.length === 0 || value.length > DISPLAY_NAME_LIMIT) {
    throw new DomainError("A media display filename must be 1 to 255 characters.");
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) {
      throw new DomainError("A media display filename cannot contain control characters.");
    }
  }
  return value;
}

/** Server-owned object key. The display filename is not an input. */
export function mediaStorageKey(ownerProjectId: ProjectId | string, sha256: string): string {
  const id = projectId(String(ownerProjectId));
  const hash = contentSha256(sha256);
  return `projects/${id}/media/sha256/${hash}`;
}

export function assertMediaStorageKey(
  ownerProjectId: ProjectId | string,
  sha256: string,
  storageKey: string,
): string {
  const expected = mediaStorageKey(ownerProjectId, sha256);
  if (storageKey !== expected) {
    throw new DomainError("MediaAsset storage key must be the server content-addressed key.");
  }
  return expected;
}

function parseByteSize(value: number | string): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new DomainError("Media byte size must be an integer number of bytes.");
    }
    return BigInt(value);
  }
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new DomainError("Media byte size must be an integer number of bytes.");
  }
  return BigInt(value);
}

import { DomainError } from "../../kernel/error.js";
import type { ProjectId, UserId, MediaAssetId } from "../../kernel/id.js";

/** 16 MiB: 256 parts at 4 GiB, comfortably above S3's 5 MiB minimum. */
export const PART_SIZE_BYTES = 16 * 1024 * 1024;
export const UPLOAD_SESSION_TTL_MS = 24n * 60n * 60n * 1000n;
export type UploadSessionStatus =
  "active" | "completing" | "completed" | "aborted" | "expired" | "failed";
export interface UploadSession {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly userId: UserId;
  readonly storageKey: string;
  readonly multipartUploadId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly partSize: number;
  readonly createdAt: bigint;
  readonly expiresAt: bigint;
  updatedAt: bigint;
  status: UploadSessionStatus;
  mediaAssetId: MediaAssetId | null;
}
export interface UploadPart {
  readonly uploadSessionId: string;
  readonly partNumber: number;
  readonly etag: string;
  readonly byteSize: number;
  readonly checksum: string | null;
  readonly completedAt: bigint;
}
/** Row operations run under a cross-process session lock. Saves must be durable before returning. */
export interface LockedUpload {
  readonly session: UploadSession;
  readonly parts: UploadPart[];
  save(): Promise<void>;
  record(part: UploadPart): Promise<void>;
}
export interface UploadSessionRepository {
  create(session: UploadSession): Promise<void>;
  findReusable(projectId: ProjectId, userId: UserId, sha256: string): Promise<string | null>;
  withSession<T>(id: string, action: (upload: LockedUpload | null) => Promise<T>): Promise<T>;
  expired(now: bigint, limit: number): Promise<readonly string[]>;
}
export function uploadPartBytes(byteSize: number, partSize: number, partNumber: number): number {
  const count = Math.ceil(byteSize / partSize);
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > count || count > 10_000) {
    throw new DomainError("The upload part number is not valid.");
  }
  return Math.min(partSize, byteSize - (partNumber - 1) * partSize);
}

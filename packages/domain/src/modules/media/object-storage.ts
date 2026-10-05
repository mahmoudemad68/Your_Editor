/**
 * Object storage port. Keys are opaque strings chosen by the caller.
 * This interface has no AWS SDK types. US-122 implements it for S3 and MinIO.
 */

export interface PresignPutRequest {
  readonly key: string;
  readonly contentType: string;
  readonly checksumSha256Hex: string;
  readonly expiresInSeconds: number;
  /** When true, the upload must fail if an object already exists at the key. */
  readonly onlyIfAbsent: boolean;
}

export interface PresignedPut {
  readonly url: string;
  readonly requiredHeaders: Readonly<Record<string, string>>;
}

export interface PresignedGet {
  readonly url: string;
}

export interface ObjectStat {
  readonly byteSize: bigint;
  readonly contentType: string | null;
  readonly checksumSha256Hex: string | null;
}

export interface IObjectStorage {
  put(key: string, body: Uint8Array, contentType: string, checksumSha256Hex: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  presignPut(request: PresignPutRequest): Promise<PresignedPut>;
  presignGet(key: string, expiresInSeconds: number): Promise<PresignedGet>;
  /** Null when absent. Adapters verify whole-object SHA-256, streaming when needed. */
  stat(key: string): Promise<ObjectStat | null>;
  delete(key: string): Promise<void>;
  createMultipart(key: string, contentType: string): Promise<string>;
  presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number,
    byteSize: number,
  ): Promise<PresignedPut>;
  listParts(key: string, uploadId: string): Promise<readonly StoragePart[]>;
  completeMultipart(key: string, uploadId: string, parts: readonly StoragePart[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
}

/** Provider-neutral multipart control plane. Raw provider ids stay on the server. */
export interface StoragePart {
  readonly partNumber: number;
  readonly etag: string;
  readonly byteSize: number;
  readonly checksum: string | null;
}

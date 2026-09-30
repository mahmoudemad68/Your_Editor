/**
 * Object storage port. Keys are opaque strings chosen by the caller.
 * This interface has no AWS SDK types. US-122 implements it for S3 and MinIO.
 */

export interface PresignPutRequest {
  readonly key: string;
  readonly contentType: string;
  readonly checksumSha256Hex: string;
  readonly expiresInSeconds: number;
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
  /** Null when the object is absent. Does not download the body. */
  stat(key: string): Promise<ObjectStat | null>;
  delete(key: string): Promise<void>;
}

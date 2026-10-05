import { createHash } from "node:crypto";
import {
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  contentSha256,
  type IObjectStorage,
  type StoragePart,
  type ObjectStat,
  type PresignedGet,
  type PresignedPut,
  type PresignPutRequest,
} from "@editagent/domain";

export interface S3ObjectStorageConfig {
  readonly endpoint: string;
  readonly publicEndpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
}

/**
 * S3-compatible adapter. API calls use the internal endpoint.
 * Presigned browser URLs use the public endpoint. The bucket stays private.
 */
export class S3ObjectStorage implements IObjectStorage {
  private readonly bucket: string;
  private readonly internal: S3Client;
  private readonly publicClient: S3Client;

  constructor(config: S3ObjectStorageConfig) {
    this.bucket = config.bucket;
    this.internal = clientFor(config, config.endpoint);
    this.publicClient = clientFor(config, config.publicEndpoint);
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.internal.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (!bucketExists(error)) {
        throw error;
      }
    }
  }

  async put(
    key: string,
    body: Uint8Array,
    contentType: string,
    checksumSha256Hex: string,
  ): Promise<void> {
    await this.internal.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ChecksumSHA256: sha256HexToBase64(checksumSha256Hex),
      }),
    );
  }

  async get(key: string): Promise<Uint8Array> {
    const response = await this.internal.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (response.Body === undefined) {
      return new Uint8Array();
    }
    return response.Body.transformToByteArray();
  }

  async presignPut(request: PresignPutRequest): Promise<PresignedPut> {
    const checksum = sha256HexToBase64(request.checksumSha256Hex);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: request.key,
      ContentType: request.contentType,
      ChecksumSHA256: checksum,
      ...(request.onlyIfAbsent ? { IfNoneMatch: "*" } : {}),
    });
    const url = await getSignedUrl(this.publicClient, command, {
      expiresIn: request.expiresInSeconds,
      signableHeaders: new Set(["content-type", "if-none-match"]),
      unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
    });
    const requiredHeaders: Record<string, string> = {
      "Content-Type": request.contentType,
      "x-amz-checksum-sha256": checksum,
    };
    if (request.onlyIfAbsent) {
      requiredHeaders["If-None-Match"] = "*";
    }
    return { url, requiredHeaders };
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<PresignedGet> {
    const url = await getSignedUrl(
      this.publicClient,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
    return { url };
  }

  async stat(key: string): Promise<ObjectStat | null> {
    try {
      const response = await this.internal.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key, ChecksumMode: "ENABLED" }),
      );
      return {
        byteSize: BigInt(response.ContentLength ?? 0),
        contentType: response.ContentType ?? null,
        // Multipart ETag/checksum metadata is not a whole-file SHA-256. Hash
        // streamed bytes for both flows, with memory bounded by the SDK stream.
        checksumSha256Hex: await this.hashObject(key, BigInt(response.ContentLength ?? 0)),
      };
    } catch (error) {
      if (isMissingObject(error)) {
        return null;
      }
      throw error;
    }
  }

  private async hashObject(key: string, expectedBytes: bigint): Promise<string> {
    const response = await this.internal.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!response.Body) throw new Error("Object body is missing.");
    const stream = response.Body as AsyncIterable<Uint8Array>;
    const hash = createHash("sha256");
    let size = 0n;
    for await (const chunk of stream) {
      size += BigInt(chunk.byteLength);
      if (size > expectedBytes) throw new Error("Object size changed.");
      hash.update(chunk);
    }
    if (size !== expectedBytes) throw new Error("Object size changed.");
    return hash.digest("hex");
  }
  async createMultipart(key: string, contentType: string): Promise<string> {
    const result = await this.internal.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
    );
    if (!result.UploadId) throw new Error("Multipart upload id is missing.");
    return result.UploadId;
  }
  async presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number,
    byteSize: number,
  ): Promise<PresignedPut> {
    const url = await getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        ContentLength: byteSize,
      }),
      { expiresIn: expiresInSeconds, signableHeaders: new Set(["content-length"]) },
    );
    return { url, requiredHeaders: {} };
  }
  async listParts(key: string, uploadId: string): Promise<readonly StoragePart[]> {
    const parts: StoragePart[] = [];
    let marker: string | undefined;
    do {
      const result = await this.internal.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      );
      for (const part of result.Parts ?? [])
        parts.push({
          partNumber: part.PartNumber ?? 0,
          etag: part.ETag ?? "",
          byteSize: part.Size ?? 0,
          checksum: part.ChecksumSHA256 ?? null,
        });
      marker = result.IsTruncated ? result.NextPartNumberMarker : undefined;
    } while (marker !== undefined);
    return parts;
  }
  async completeMultipart(
    key: string,
    uploadId: string,
    parts: readonly StoragePart[],
  ): Promise<void> {
    try {
      await this.internal.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          IfNoneMatch: "*",
          MultipartUpload: {
            Parts: [...parts]
              .sort((a, b) => a.partNumber - b.partNumber)
              .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
          },
        }),
      );
    } catch (error) {
      if (statusCode(error) === 412) {
        await this.abortMultipart(key, uploadId);
        return;
      }
      if (named(error, "NoSuchUpload") && (await this.stat(key)) !== null) return;
      throw error;
    }
  }
  async abortMultipart(key: string, uploadId: string): Promise<void> {
    try {
      await this.internal.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
      );
    } catch (error) {
      if (!named(error, "NoSuchUpload")) throw error;
    }
  }
  /** Operations cleanup also catches provider uploads orphaned before DB insertion. */
  async abortStaleMultipart(before: Date): Promise<number> {
    let count = 0;
    let keyMarker: string | undefined;
    let uploadMarker: string | undefined;
    do {
      const result = await this.internal.send(
        new ListMultipartUploadsCommand({
          Bucket: this.bucket,
          Prefix: "projects/",
          KeyMarker: keyMarker,
          UploadIdMarker: uploadMarker,
        }),
      );
      for (const upload of result.Uploads ?? [])
        if (upload.Key && upload.UploadId && upload.Initiated && upload.Initiated < before) {
          await this.abortMultipart(upload.Key, upload.UploadId);
          count++;
        }
      keyMarker = result.IsTruncated ? result.NextKeyMarker : undefined;
      uploadMarker = result.IsTruncated ? result.NextUploadIdMarker : undefined;
    } while (keyMarker !== undefined);
    return count;
  }
  close(): void {
    this.internal.destroy();
    this.publicClient.destroy();
  }
  async delete(key: string): Promise<void> {
    await this.internal.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

function clientFor(config: S3ObjectStorageConfig, endpoint: string): S3Client {
  return new S3Client({
    region: config.region,
    endpoint,
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

function sha256HexToBase64(hex: string): string {
  return Buffer.from(contentSha256(hex), "hex").toString("base64");
}

function isMissingObject(error: unknown): boolean {
  return named(error, "NotFound") || named(error, "NoSuchKey") || statusCode(error) === 404;
}

function bucketExists(error: unknown): boolean {
  return (
    named(error, "BucketAlreadyOwnedByYou") ||
    named(error, "BucketAlreadyExists") ||
    statusCode(error) === 409
  );
}

function named(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === name;
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) {
    return undefined;
  }
  const metadata = error.$metadata;
  if (typeof metadata !== "object" || metadata === null || !("httpStatusCode" in metadata)) {
    return undefined;
  }
  return typeof metadata.httpStatusCode === "number" ? metadata.httpStatusCode : undefined;
}

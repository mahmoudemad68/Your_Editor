import {
  CreateBucketCommand,
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
    });
    const url = await getSignedUrl(this.publicClient, command, {
      expiresIn: request.expiresInSeconds,
    });
    return {
      url,
      requiredHeaders: {
        "Content-Type": request.contentType,
        "x-amz-checksum-sha256": checksum,
      },
    };
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
        checksumSha256Hex:
          response.ChecksumSHA256 === undefined ? null : base64ToSha256Hex(response.ChecksumSHA256),
      };
    } catch (error) {
      if (isMissingObject(error)) {
        return null;
      }
      throw error;
    }
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
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

function sha256HexToBase64(hex: string): string {
  return Buffer.from(contentSha256(hex), "hex").toString("base64");
}

function base64ToSha256Hex(value: string): string {
  return Buffer.from(value, "base64").toString("hex");
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

import { Readable } from "node:stream";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { MediaProbeError } from "@editagent/domain";
import { type ObjectStorageConfig } from "@editagent/shared";
import { type ObjectByteSource, type OpenedObject } from "./object-byte-source.js";

export function createMediaS3Client(config: ObjectStorageConfig): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

/** Server-side object read. Errors do not include credentials, signed URLs, or object keys. */
export class S3ObjectByteSource implements ObjectByteSource {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async open(storageKey: string): Promise<OpenedObject> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }),
      );
      if (!(response.Body instanceof Readable)) {
        throw new MediaProbeError("interrupted");
      }
      return {
        stream: response.Body,
        contentLength: response.ContentLength === undefined ? null : BigInt(response.ContentLength),
      };
    } catch (error) {
      if (error instanceof MediaProbeError) {
        throw error;
      }
      throw new MediaProbeError(isMissingObject(error) ? "object_missing" : "interrupted");
    }
  }
}

function isMissingObject(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if ("name" in error && (error.name === "NoSuchKey" || error.name === "NotFound")) {
    return true;
  }
  if (!("$metadata" in error) || typeof error.$metadata !== "object" || error.$metadata === null) {
    return false;
  }
  return "httpStatusCode" in error.$metadata && error.$metadata.httpStatusCode === 404;
}

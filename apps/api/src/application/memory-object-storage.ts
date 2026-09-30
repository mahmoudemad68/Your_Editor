import {
  type IObjectStorage,
  type ObjectStat,
  type PresignedGet,
  type PresignedPut,
  type PresignPutRequest,
} from "@editagent/domain";

interface StoredObject {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly checksumSha256Hex: string;
}

/** In-memory object store for use-case tests. It does not speak S3. */
export class MemoryObjectStorage implements IObjectStorage {
  readonly objects = new Map<string, StoredObject>();
  readonly publicEndpoint: string;

  constructor(publicEndpoint = "http://localhost:9000") {
    this.publicEndpoint = publicEndpoint;
  }

  async put(
    key: string,
    body: Uint8Array,
    contentType: string,
    checksumSha256Hex: string,
  ): Promise<void> {
    this.objects.set(key, { body, contentType, checksumSha256Hex });
  }

  async get(key: string): Promise<Uint8Array> {
    const stored = this.objects.get(key);
    if (stored === undefined) {
      throw new Error("missing object");
    }
    return stored.body;
  }

  async presignPut(request: PresignPutRequest): Promise<PresignedPut> {
    return {
      url: `${this.publicEndpoint}/editagent/${request.key}`,
      requiredHeaders: {
        "Content-Type": request.contentType,
        "x-amz-checksum-sha256": request.checksumSha256Hex,
        ...(request.onlyIfAbsent ? { "If-None-Match": "*" } : {}),
      },
    };
  }

  async presignGet(key: string): Promise<PresignedGet> {
    return { url: `${this.publicEndpoint}/editagent/${key}` };
  }

  async stat(key: string): Promise<ObjectStat | null> {
    const stored = this.objects.get(key);
    if (stored === undefined) {
      return null;
    }
    return {
      byteSize: BigInt(stored.body.byteLength),
      contentType: stored.contentType,
      checksumSha256Hex: stored.checksumSha256Hex,
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

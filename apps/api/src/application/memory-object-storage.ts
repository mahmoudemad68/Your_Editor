import { createHash, randomUUID } from "node:crypto";
import {
  type IObjectStorage,
  type StoragePart,
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

  readonly multipart = new Map<
    string,
    { key: string; contentType: string; parts: Map<number, { bytes: Uint8Array; etag: string }> }
  >();
  async createMultipart(key: string, contentType: string): Promise<string> {
    const id = randomUUID();
    this.multipart.set(id, { key, contentType, parts: new Map() });
    return id;
  }
  async presignPart(key: string, uploadId: string, partNumber: number): Promise<PresignedPut> {
    return {
      url: `${this.publicEndpoint}/${key}?uploadId=${uploadId}&partNumber=${partNumber}`,
      requiredHeaders: {},
    };
  }
  async listParts(key: string, uploadId: string): Promise<readonly StoragePart[]> {
    const upload = this.multipart.get(uploadId);
    if (!upload || upload.key !== key) throw new Error("NoSuchUpload");
    return [...upload.parts].map(([partNumber, p]) => ({
      partNumber,
      etag: p.etag,
      byteSize: p.bytes.byteLength,
      checksum: null,
    }));
  }
  async completeMultipart(
    key: string,
    uploadId: string,
    parts: readonly StoragePart[],
  ): Promise<void> {
    const upload = this.multipart.get(uploadId);
    if (!upload) {
      if (this.objects.has(key)) return;
      throw new Error("NoSuchUpload");
    }
    if (!this.objects.has(key)) {
      const chunks = [...parts]
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((p) => upload.parts.get(p.partNumber)!.bytes);
      const bytes = Buffer.concat(chunks);
      await this.put(
        key,
        bytes,
        upload.contentType,
        createHash("sha256").update(bytes).digest("hex"),
      );
    }
    this.multipart.delete(uploadId);
  }
  async abortMultipart(_key: string, uploadId: string): Promise<void> {
    this.multipart.delete(uploadId);
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

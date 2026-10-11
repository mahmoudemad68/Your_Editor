import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, open } from "node:fs/promises";
import path from "node:path";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { PermanentJobError } from "@editagent/job-queue";
import type { StorageWorkerConfig } from "./config.js";
export function createStorage(config: StorageWorkerConfig) {
  return new S3Client({
    endpoint: config.objectStorage.endpoint,
    region: config.objectStorage.region,
    credentials: {
      accessKeyId: config.objectStorage.accessKeyId,
      secretAccessKey: config.objectStorage.secretAccessKey,
    },
    forcePathStyle: true,
    maxAttempts: 2,
  });
}
export async function workspace() {
  const token = randomBytes(16).toString("hex");
  const work = path.join("/render-work", token);
  await mkdir(work, { mode: 0o700 });
  return { token, work, close: () => rm(work, { recursive: true, force: true }) };
}
export async function fileSha(file: string, signal: AbortSignal) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) h.update(chunk as Buffer);
  return h.digest("hex");
}
export async function stageObject(
  client: S3Client,
  bucket: string,
  key: string,
  file: string,
  expected: { sha256: string; byteSize: number },
  signal: AbortSignal,
) {
  if (
    !/^[a-f0-9]{64}$/.test(expected.sha256) ||
    !Number.isSafeInteger(expected.byteSize) ||
    expected.byteSize < 1 ||
    expected.byteSize > 1073741824
  )
    throw new PermanentJobError("Invalid source object identity.");
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
    abortSignal: signal,
  });
  if (result.ContentLength !== expected.byteSize || !result.Body) {
    (result.Body as { destroy?: () => void } | undefined)?.destroy?.();
    throw new PermanentJobError("Source object size changed.");
  }
  const handle = await open(file, "wx", 0o600);
  const hash = createHash("sha256");
  let count = 0;
  try {
    for await (const raw of result.Body as AsyncIterable<Uint8Array>) {
      signal.throwIfAborted();
      const data = Buffer.from(raw);
      count += data.length;
      if (count > expected.byteSize)
        throw new PermanentJobError("Source object exceeds its identity.");
      hash.update(data);
      let offset = 0;
      while (offset < data.length) {
        const written = await handle.write(data, offset, data.length - offset);
        offset += written.bytesWritten;
      }
    }
    if (count !== expected.byteSize || hash.digest("hex") !== expected.sha256)
      throw new PermanentJobError("Source object checksum changed.");
  } finally {
    await handle.close();
    (result.Body as { destroy?: () => void }).destroy?.();
  }
}
export class RenderObjects {
  constructor(
    private client: S3Client,
    private bucket: string,
  ) {}
  async find(
    key: string,
    signature: string,
    signal: AbortSignal,
  ): Promise<{ sha256: string; byteSize: number } | null> {
    try {
      const h = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), {
        abortSignal: signal,
      });
      if (
        h.ContentType !== "video/mp4" ||
        h.Metadata?.signature !== signature ||
        !/^[a-f0-9]{64}$/.test(h.Metadata?.sha256 ?? "") ||
        !h.ContentLength ||
        h.ContentLength > 1073741824
      )
        throw new PermanentJobError("Render output identity conflict.");
      return { sha256: h.Metadata.sha256!, byteSize: h.ContentLength };
    } catch (e) {
      signal.throwIfAborted();
      if (status(e) === 404) return null;
      throw e;
    }
  }
  async put(key: string, signature: string, file: string, signal: AbortSignal) {
    const byteSize = (await stat(file)).size;
    const sha256 = await fileSha(file, signal);
    const body = createReadStream(file, { signal });
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ContentType: "video/mp4",
          ContentLength: byteSize,
          Body: body,
          IfNoneMatch: "*",
          Metadata: { signature, sha256 },
        }),
        { abortSignal: signal },
      );
    } catch (e) {
      if (signal.aborted) {
        await this.remove(key, signature);
        signal.throwIfAborted();
      }
      if (status(e) !== 412 && status(e) !== 409)
        throw new Error("Render upload failed.", { cause: e });
    } finally {
      body.destroy();
    }
    signal.throwIfAborted();
    const existing = await this.find(key, signature, signal);
    if (!existing || existing.sha256 !== sha256 || existing.byteSize !== byteSize)
      throw new PermanentJobError("Render conditional upload conflict.");
    return existing;
  }
  async remove(key: string, signature: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const found = await this.find(key, signature, controller.signal);
      if (found)
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), {
          abortSignal: controller.signal,
        });
    } finally {
      clearTimeout(timer);
    }
  }
  async stage(
    key: string,
    file: string,
    expected: { sha256: string; byteSize: number },
    signal: AbortSignal,
  ) {
    await stageObject(this.client, this.bucket, key, file, expected, signal);
  }
}
function status(e: unknown) {
  return (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

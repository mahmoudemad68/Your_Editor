import { createWriteStream } from "node:fs";
import { mkdtemp, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MAX_MEDIA_BYTES, MediaProbeError } from "@editagent/domain";
import { type MediaObjectStaging, type StagedMediaFile } from "../application/inspect-media.js";
import { type ObjectByteSource } from "./object-byte-source.js";

export interface FileObjectStagerOptions {
  readonly source: ObjectByteSource;
  readonly rootDir?: string;
  readonly freeBytes?: (directory: string) => Promise<bigint>;
  readonly maxBytes?: bigint;
}

/** Streams an object into a server-named temporary file. The display filename is not a path. */
export class FileObjectStager implements MediaObjectStaging {
  private readonly source: ObjectByteSource;
  private readonly rootDir: string;
  private readonly freeBytes: (directory: string) => Promise<bigint>;
  private readonly maxBytes: bigint;

  constructor(options: FileObjectStagerOptions) {
    this.source = options.source;
    this.rootDir = options.rootDir ?? tmpdir();
    this.freeBytes = options.freeBytes ?? availableBytes;
    this.maxBytes = options.maxBytes ?? MAX_MEDIA_BYTES;
    if (!path.isAbsolute(this.rootDir)) {
      throw new MediaProbeError("invalid_result");
    }
  }

  async stage(storageKey: string): Promise<StagedMediaFile> {
    const opened = await this.source.open(storageKey);
    if (opened.contentLength !== null && opened.contentLength > this.maxBytes) {
      opened.stream.destroy();
      throw new MediaProbeError("invalid_result");
    }
    const directory = await mkdtemp(path.join(this.rootDir, "editagent-probe-"));
    const filePath = path.join(directory, "source.bin");
    try {
      const free = await this.freeBytes(directory);
      const needed = opened.contentLength ?? 1n;
      if (free < needed) {
        throw new MediaProbeError("insufficient_storage");
      }
      await pipeline(opened.stream, capBytes(this.maxBytes), createWriteStream(filePath));
      return {
        filePath,
        release: async () => {
          await rm(directory, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw asProbeError(error);
    }
  }
}

function capBytes(max: bigint): Transform {
  let seen = 0n;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      seen += BigInt(chunk.length);
      if (seen > max) {
        callback(new MediaProbeError("invalid_result"));
        return;
      }
      callback(null, chunk);
    },
  });
}

async function availableBytes(directory: string): Promise<bigint> {
  const stats = await statfs(directory);
  return BigInt(stats.bavail) * BigInt(stats.bsize);
}

function asProbeError(error: unknown): MediaProbeError {
  if (error instanceof MediaProbeError) {
    return error;
  }
  if (isNoSpace(error)) {
    return new MediaProbeError("insufficient_storage");
  }
  return new MediaProbeError("interrupted");
}

function isNoSpace(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOSPC";
}

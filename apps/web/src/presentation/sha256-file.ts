import { sha256 } from "@noble/hashes/sha2";

const DEFAULT_CHUNK_BYTES = 1024 * 1024;

export interface HashOptions {
  readonly chunkBytes?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (loaded: number, total: number) => void;
}

/** Incremental SHA-256. Each chunk is released before the next one is read. */
export async function hashBlob(blob: Blob, options: HashOptions = {}): Promise<string> {
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const hasher = sha256.create();
  let offset = 0;
  while (offset < blob.size) {
    if (options.signal?.aborted) {
      throw new DOMException("The hash was cancelled.", "AbortError");
    }
    const slice = blob.slice(offset, Math.min(blob.size, offset + chunkBytes));
    const bytes = new Uint8Array(await slice.arrayBuffer());
    hasher.update(bytes);
    offset += bytes.byteLength;
    options.onProgress?.(offset, blob.size);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (options.signal?.aborted) {
    throw new DOMException("The hash was cancelled.", "AbortError");
  }
  return toHex(hasher.digest());
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

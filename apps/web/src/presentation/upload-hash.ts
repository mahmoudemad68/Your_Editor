import { hashBlob, type HashOptions } from "./sha256-file";

/**
 * Hashes a file off the UI thread. The bundler turns this URL into a JavaScript
 * worker chunk. If that chunk cannot start, hashing falls back to the same
 * chunked function on this thread.
 */
export function hashFileInWorker(file: Blob, options: HashOptions = {}): Promise<string> {
  if (typeof Worker === "undefined") {
    return hashBlob(file, options);
  }
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./sha256.worker.ts", import.meta.url));
    } catch {
      hashBlob(file, options).then(resolve, reject);
      return;
    }
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      action();
    };
    const onAbort = () => {
      finish(() => reject(new DOMException("The hash was cancelled.", "AbortError")));
    };
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort);
    worker.onmessage = (
      event: MessageEvent<{
        type: string;
        loaded?: number;
        total?: number;
        hex?: string;
        message?: string;
      }>,
    ) => {
      const data = event.data;
      if (data.type === "progress" && data.loaded !== undefined && data.total !== undefined) {
        options.onProgress?.(data.loaded, data.total);
      } else if (data.type === "done" && typeof data.hex === "string") {
        const hex = data.hex;
        finish(() => resolve(hex));
      } else if (data.type === "error") {
        finish(() => reject(new Error(data.message ?? "Hashing failed.")));
      }
    };
    worker.onerror = () => {
      finish(() => {
        hashBlob(file, options).then(resolve, reject);
      });
    };
    worker.postMessage({ file });
  });
}

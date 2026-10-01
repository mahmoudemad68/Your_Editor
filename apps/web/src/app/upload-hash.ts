import { hashBlob, type HashOptions } from "../presentation/sha256-file";

/**
 * Hashes a file off the UI thread. Falls back to chunked hashing in this
 * thread if the worker cannot start. US-118 does not change this step.
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
        finish(() => resolve(data.hex as string));
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

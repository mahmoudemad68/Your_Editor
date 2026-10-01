export interface SignedPutRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Blob;
  readonly signal?: AbortSignal;
  readonly onProgress?: (loaded: number, total: number) => void;
}

export interface SignedPutResult {
  readonly ok: boolean;
  readonly status: number;
}

/**
 * PUT bytes to the presigned URL. Headers are copied unchanged.
 * HTTP 412 is not success. Progress comes only from the request.
 */
export function putSignedObject(request: SignedPutRequest): Promise<SignedPutResult> {
  return new Promise((resolve, reject) => {
    if (request.signal?.aborted) {
      reject(new DOMException("The upload was cancelled.", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", request.url);
    for (const [name, value] of Object.entries(request.headers)) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        request.onProgress?.(event.loaded, event.total);
      }
    };
    const onAbort = () => xhr.abort();
    request.signal?.addEventListener("abort", onAbort);
    xhr.onload = () => {
      request.signal?.removeEventListener("abort", onAbort);
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status });
    };
    xhr.onerror = () => {
      request.signal?.removeEventListener("abort", onAbort);
      resolve({ ok: false, status: 0 });
    };
    xhr.onabort = () => {
      request.signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("The upload was cancelled.", "AbortError"));
    };
    xhr.send(request.body);
  });
}

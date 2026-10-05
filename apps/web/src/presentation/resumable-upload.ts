import type { MultipartApi, UploadDeclaration, MediaAssetRecord } from "../project-contract";
import { UploadRequestError } from "./multipart-api";
import { putSignedObject, type SignedPutRequest, type SignedPutResult } from "./signed-upload";
import { UploadProgress, missingParts, type TransferProgress } from "./upload-progress";
import type { UploadStateStore, SavedUpload } from "./upload-state";
export const MULTIPART_THRESHOLD_BYTES = 16 * 1024 * 1024;
export const MAX_UPLOAD_CONCURRENCY = 3;
export const MAX_PART_ATTEMPTS = 4;
export type TransferStage = "resuming" | "uploading" | "paused" | "completing" | "completed";
export interface TransferUpdate extends TransferProgress {
  readonly stage: TransferStage;
}
export function retryableStatus(status: number): boolean {
  return [0, 408, 500, 502, 503, 504].includes(status);
}
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  return Math.min(8000, 500 * 2 ** attempt) * (0.5 + random() * 0.5);
}
export function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Upload paused.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
export async function resumeMultipart(options: {
  file: File;
  declaration: UploadDeclaration;
  projectId: string;
  scope: string;
  api: MultipartApi;
  store: UploadStateStore;
  signal: AbortSignal;
  onUpdate: (update: TransferUpdate) => void;
  onRecord?: (record: SavedUpload | null) => void;
  put?: (request: SignedPutRequest) => Promise<SignedPutResult>;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
}): Promise<MediaAssetRecord> {
  const { file, declaration, projectId, scope, api, store, signal, onUpdate } = options;
  signal.throwIfAborted();
  const previous = await store.get(scope);
  if (
    previous &&
    (previous.projectId !== projectId ||
      previous.sha256 !== declaration.sha256 ||
      previous.byteSize !== declaration.byteSize ||
      previous.mimeType !== declaration.mimeType ||
      previous.filename !== declaration.filename)
  )
    throw new UploadRequestError(
      409,
      "This file does not match the saved upload. Reselect the same file or discard that upload.",
    );
  const state = previous
    ? await api.state(projectId, previous.uploadSessionId, signal)
    : await api.start(projectId, declaration, signal);
  if (
    state.sha256 !== declaration.sha256 ||
    state.byteSize !== file.size ||
    state.mimeType !== declaration.mimeType ||
    state.filename !== file.name
  )
    throw new UploadRequestError(409, "The saved upload does not match this file.");
  const record: SavedUpload = {
    ...declaration,
    scope,
    projectId,
    uploadSessionId: state.uploadSessionId,
    partSize: state.partSize,
    lastModified: file.lastModified,
    updatedAt: Date.now(),
  };
  await store.save(record);
  signal.throwIfAborted();
  options.onRecord?.(record);
  // Validate before allocating timers/listeners so malformed recovery cannot leak them.
  const parts =
    state.status === "active" ? missingParts(file.size, state.partSize, state.parts) : [];
  const progress = new UploadProgress(file.size, state.parts, options.now);
  const emit = (next: TransferStage) => {
    stage = next;
    if (!signal.aborted)
      onUpdate({
        ...progress.snapshot(next === "completed"),
        ...(["paused", "completing"].includes(next) ? { speed: 0, eta: null } : {}),
        stage: next,
      });
  };
  let stage: TransferStage = "uploading";
  emit(previous ? "resuming" : "uploading");
  const local = new AbortController();
  const abort = () => local.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  let index = 0;
  const timer = setInterval(() => emit(stage), 250);
  let firstError: unknown;
  const put = options.put ?? putSignedObject,
    wait = options.wait ?? abortableWait;
  async function upload(partNumber: number): Promise<void> {
    const begin = (partNumber - 1) * state.partSize;
    const body = file.slice(begin, Math.min(file.size, begin + state.partSize));
    for (let attempt = 0; attempt < MAX_PART_ATTEMPTS; attempt++) {
      local.signal.throwIfAborted();
      progress.reset(partNumber);
      try {
        if (attempt > 0) {
          const recovered = await api.state(projectId, state.uploadSessionId, local.signal);
          const done = recovered.parts.find((p) => p.partNumber === partNumber);
          if (done) {
            progress.commit(partNumber, done.byteSize);
            emit("uploading");
            return;
          }
        }
        const signed = await api.sign(projectId, state.uploadSessionId, partNumber, local.signal);
        const result = await put({
          url: signed.url,
          headers: signed.requiredHeaders,
          body,
          signal: local.signal,
          onProgress: (loaded) => {
            if (!local.signal.aborted) {
              progress.progress(partNumber, Math.min(body.size, loaded));
              emit("uploading");
            }
          },
        });
        if (!result.ok) {
          if (result.expired) throw new UploadRequestError(408, "The part URL expired.");
          throw new UploadRequestError(
            result.status,
            "The part transfer was interrupted or rejected.",
          );
        }
        // Recover provider-confirmed bytes even if an ETag was not exposed by CORS.
        const confirmed = result.etag
          ? await api.record(
              projectId,
              state.uploadSessionId,
              partNumber,
              result.etag,
              local.signal,
            )
          : await api.state(projectId, state.uploadSessionId, local.signal);
        const durable = confirmed.parts.find((p) => p.partNumber === partNumber);
        if (!durable || durable.byteSize !== body.size)
          throw new UploadRequestError(409, "The stored part was not verified.");
        progress.commit(partNumber, durable.byteSize);
        emit("uploading");
        return;
      } catch (error) {
        if (local.signal.aborted) throw error;
        const retry = error instanceof UploadRequestError && retryableStatus(error.status);
        if (!retry || attempt === MAX_PART_ATTEMPTS - 1) throw error;
        progress.reset(partNumber);
        emit("paused");
        await wait(retryDelay(attempt, options.random), local.signal);
      }
    }
  }
  try {
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(MAX_UPLOAD_CONCURRENCY, parts.length) }, async () => {
        try {
          while (index < parts.length) {
            const n = parts[index++]!;
            await upload(n);
          }
        } catch (error) {
          firstError ??= error;
          local.abort();
          throw error;
        }
      }),
    );
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) {
      progress.pause();
      emit("paused");
      throw firstError ?? failed.reason;
    }
    signal.throwIfAborted();
    stage = "completing";
    clearInterval(timer);
    emit(stage);
    const asset = await api.complete(projectId, state.uploadSessionId, signal);
    await store.remove(scope);
    signal.throwIfAborted();
    options.onRecord?.(null);
    emit("completed");
    return asset;
  } finally {
    clearInterval(timer);
    signal.removeEventListener("abort", abort);
  }
}

"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import type {
  MediaDetails,
  ProjectApi,
  ProjectRecord,
  UploadDeclaration,
} from "../project-contract";
import { hashBlob, type HashOptions } from "./sha256-file";
import { projectJobEvents } from "./job-event-stream";
import { MediaJobProgress } from "./job-progress";
import type { JobStatusApi, JobEventStream } from "../job-contract";
import { MediaDetailsPanel } from "./media-details";
import { putSignedObject, type SignedPutRequest, type SignedPutResult } from "./signed-upload";
import { browserMultipartApi, UploadRequestError } from "./multipart-api";
import { IndexedUploadState, type UploadStateStore, type SavedUpload } from "./upload-state";
import {
  resumeMultipart,
  MULTIPART_THRESHOLD_BYTES,
  retryableStatus,
  type TransferUpdate,
} from "./resumable-upload";
import { sessionClient } from "./session-client";
import type { MultipartApi } from "../project-contract";
import { Button } from "./ui/button";
import { formatBytes, validateMediaFile } from "./upload-policy";

const durableUploads = new IndexedUploadState();

type Phase =
  | { status: "idle" }
  | { status: "resumable"; name: string; size: number; transfer: TransferUpdate }
  | { status: "hashing"; name: string; size: number; loaded: number; total: number }
  | { status: "requesting-upload"; name: string; size: number }
  | { status: "uploading"; name: string; size: number; loaded: number; total: number }
  | { status: "completing"; name: string; size: number }
  | { status: "uploaded"; name: string; details: MediaDetails }
  | { status: "error"; message: string }
  | { status: "discarding" }
  | { status: "cancelled" };

export function MediaWorkspace({
  project,
  api,
  hashFile = hashBlob,
  putObject = putSignedObject,
  multipartApi = browserMultipartApi,
  uploadState = durableUploads,
  jobApi,
  jobStream,
}: {
  project: ProjectRecord;
  jobApi?: JobStatusApi;
  jobStream?: JobEventStream;
  api: ProjectApi;
  hashFile?: (file: Blob, options?: HashOptions) => Promise<string>;
  putObject?: (request: SignedPutRequest) => Promise<SignedPutResult>;
  multipartApi?: MultipartApi;
  uploadState?: UploadStateStore;
}) {
  // Hold one project connection across visible media/card identity changes.
  useEffect(
    () => (jobStream ?? projectJobEvents).subscribe(project.id, { event() {}, reconcile() {} }),
    [project.id, jobStream],
  );
  const [phase, setPhase] = useState<Phase>({ status: "idle" });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const mountedRef = useRef(true);
  // Identifies the upload that may change visible state. Cancel, unmount, and a new
  // file increment it synchronously so an older async result cannot render.
  const generationRef = useRef(0);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const detailsAbortRef = useRef<AbortController | null>(null);
  // Orders media-detail responses. A slower older response must not replace a newer one.
  const detailsSeqRef = useRef(0);
  const [savedUpload, setSavedUpload] = useState<SavedUpload | null>(null);
  const selectedFile = useRef<File | null>(null);
  const identity = sessionClient.getSnapshot();
  const scope = `${identity.status === "authenticated" ? identity.user.id : "anonymous"}:${project.id}`;
  useEffect(() => {
    const controller = new AbortController();
    async function recover() {
      if (busyRef.current) return;
      const generation = generationRef.current;
      try {
        const record = await uploadState.get(scope);
        if (
          controller.signal.aborted ||
          generationRef.current !== generation ||
          !record ||
          record.projectId !== project.id
        )
          return;
        setSavedUpload(record);
        const state = await multipartApi.state(
          project.id,
          record.uploadSessionId,
          controller.signal,
        );
        if (controller.signal.aborted || generationRef.current !== generation || busyRef.current)
          return;
        if (state.status === "completed" && state.mediaAssetId) {
          await uploadState.remove(scope);
          if (controller.signal.aborted || !isCurrent(generation) || busyRef.current) return;
          setSavedUpload(null);
          await loadDetails(state.mediaAssetId, record.filename, generation, controller.signal);
        } else {
          const loaded = state.parts.reduce((sum, p) => sum + p.byteSize, 0);
          setPhase({
            status: "resumable",
            name: record.filename,
            size: record.byteSize,
            transfer: {
              stage: "paused",
              loaded,
              durableLoaded: loaded,
              total: record.byteSize,
              percent: Math.min(99.9, (loaded / record.byteSize) * 100),
              speed: 0,
              eta: null,
            },
          });
        }
      } catch {
        /* Saved metadata remains available for explicit recovery/discard. */
      }
    }
    void recover();
    window.addEventListener("online", recover);
    return () => {
      controller.abort();
      window.removeEventListener("online", recover);
    };
  }, [scope, project.id, multipartApi, uploadState]);
  const canUpload = project.role === "owner" || project.role === "editor";
  function isCurrent(generation: number): boolean {
    return mountedRef.current && generationRef.current === generation;
  }

  function applyPhase(generation: number, update: Phase | ((current: Phase) => Phase)): void {
    if (!isCurrent(generation)) {
      return;
    }
    setPhase(update);
  }

  function applyProgress(
    generation: number,
    signal: AbortSignal,
    allowed: "hashing" | "uploading",
    next: Phase,
  ): void {
    if (!isCurrent(generation) || signal.aborted) {
      return;
    }
    setPhase((current) => {
      if (!isCurrent(generation) || signal.aborted || current.status !== allowed) {
        return current;
      }
      return next;
    });
  }

  function abortDetails(): void {
    detailsAbortRef.current?.abort();
    detailsAbortRef.current = null;
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      busyRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
      detailsAbortRef.current?.abort();
      detailsAbortRef.current = null;
    };
  }, []);

  async function refresh(mediaAssetId: string, generation: number): Promise<void> {
    abortDetails();
    const seq = ++detailsSeqRef.current;
    const controller = new AbortController();
    detailsAbortRef.current = controller;
    if (isCurrent(generation)) {
      setRefreshing(true);
      setRefreshError(null);
    }
    const result = await api.getMediaDetails(project.id, mediaAssetId, {
      signal: controller.signal,
    });
    if (
      !mountedRef.current ||
      generationRef.current !== generation ||
      seq !== detailsSeqRef.current
    ) {
      return;
    }
    setRefreshing(false);
    if (!result.ok || result.data.id !== mediaAssetId) {
      setRefreshError("Details could not be refreshed.");
      return;
    }
    setPhase((current) => {
      if (current.status !== "uploaded" || current.details.id !== mediaAssetId) {
        return current;
      }
      return { status: "uploaded", name: current.name, details: result.data };
    });
  }

  async function acceptFile(file: File | undefined): Promise<void> {
    if (file === undefined || !canUpload || busyRef.current) {
      return;
    }
    busyRef.current = true;
    const generation = ++generationRef.current;
    abortRef.current?.abort();
    abortDetails();
    const controller = new AbortController();
    abortRef.current = controller;
    const validation = validateMediaFile(file);
    if ("error" in validation) {
      release(generation);
      applyPhase(generation, { status: "error", message: validation.error });
      return;
    }
    selectedFile.current = file;
    const declarationBase = {
      filename: file.name,
      mimeType: validation.mimeType,
      byteSize: file.size,
    };
    try {
      applyPhase(generation, {
        status: "hashing",
        name: file.name,
        size: file.size,
        loaded: 0,
        total: file.size,
      });
      const sha256 = await hashFile(file, {
        signal: controller.signal,
        onProgress: (loaded, total) => {
          applyProgress(generation, controller.signal, "hashing", {
            status: "hashing",
            name: file.name,
            size: file.size,
            loaded,
            total,
          });
        },
      });
      if (!isCurrent(generation) || controller.signal.aborted) {
        return;
      }
      const declaration: UploadDeclaration = { ...declarationBase, sha256 };
      if (file.size >= MULTIPART_THRESHOLD_BYTES || savedUpload !== null) {
        const asset = await resumeMultipart({
          file,
          declaration,
          projectId: project.id,
          scope,
          api: multipartApi,
          store: uploadState,
          signal: controller.signal,
          put: putObject,
          onUpdate: (transfer) => {
            if (!controller.signal.aborted)
              applyPhase(generation, {
                status: "resumable",
                name: file.name,
                size: file.size,
                transfer,
              });
          },
          onRecord: (record) => {
            if (isCurrent(generation) && !controller.signal.aborted) setSavedUpload(record);
          },
        });
        if (isCurrent(generation) && !controller.signal.aborted)
          await loadDetails(asset.id, file.name, generation, controller.signal);
        return;
      }
      applyPhase(generation, { status: "requesting-upload", name: file.name, size: file.size });
      const started = await api.beginUpload(project.id, declaration, { signal: controller.signal });
      if (!isCurrent(generation) || controller.signal.aborted) {
        return;
      }
      if (!started.ok) {
        applyPhase(generation, { status: "error", message: started.message });
        return;
      }
      applyPhase(generation, {
        status: "uploading",
        name: file.name,
        size: file.size,
        loaded: 0,
        total: file.size,
      });
      const put = await putObject({
        url: started.data.uploadUrl,
        headers: started.data.requiredHeaders,
        body: file,
        signal: controller.signal,
        onProgress: (loaded, total) => {
          applyProgress(generation, controller.signal, "uploading", {
            status: "uploading",
            name: file.name,
            size: file.size,
            loaded,
            total: total > 0 ? total : file.size,
          });
        },
      });
      if (!isCurrent(generation) || controller.signal.aborted) {
        return;
      }
      if (put.status === 412) {
        await finishAfterConditionalPut(declaration, file.name, generation, controller.signal);
        return;
      }
      if (!put.ok) {
        applyPhase(generation, { status: "error", message: putFailure(put.status) });
        return;
      }
      await finishUpload(declaration, file.name, generation, controller.signal);
    } catch (error) {
      if (!isCurrent(generation)) {
        return;
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        applyPhase(generation, { status: "cancelled" });
        return;
      }
      if (error instanceof UploadRequestError && retryableStatus(error.status)) {
        applyPhase(generation, (current) =>
          current.status === "resumable"
            ? {
                ...current,
                transfer: { ...current.transfer, stage: "paused", speed: 0, eta: null },
              }
            : { status: "error", message: error.message },
        );
      } else
        applyPhase(generation, {
          status: "error",
          message: error instanceof Error ? error.message : "The upload failed.",
        });
    } finally {
      release(generation);
    }
  }

  async function finishAfterConditionalPut(
    declaration: UploadDeclaration,
    name: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    applyPhase(generation, { status: "completing", name, size: declaration.byteSize });
    const completed = await api.completeUpload(project.id, declaration, { signal });
    if (!isCurrent(generation) || signal.aborted) {
      return;
    }
    if (!completed.ok) {
      applyPhase(generation, {
        status: "error",
        message:
          completed.status === 409
            ? completed.message
            : "The existing object was not verified. Nothing was overwritten.",
      });
      return;
    }
    await loadDetails(completed.data.id, name, generation, signal);
  }

  async function finishUpload(
    declaration: UploadDeclaration,
    name: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    applyPhase(generation, { status: "completing", name, size: declaration.byteSize });
    const completed = await api.completeUpload(project.id, declaration, { signal });
    if (!isCurrent(generation) || signal.aborted) {
      return;
    }
    if (!completed.ok) {
      applyPhase(generation, { status: "error", message: completed.message });
      return;
    }
    await loadDetails(completed.data.id, name, generation, signal);
  }

  async function loadDetails(
    mediaAssetId: string,
    name: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const seq = ++detailsSeqRef.current;
    const details = await api.getMediaDetails(project.id, mediaAssetId, { signal });
    if (!isCurrent(generation) || signal.aborted || seq !== detailsSeqRef.current) {
      return;
    }
    setRefreshing(false);
    if (!details.ok) {
      applyPhase(generation, { status: "error", message: details.message });
      return;
    }
    if (details.data.id !== mediaAssetId) {
      return;
    }
    applyPhase(generation, { status: "uploaded", name, details: details.data });
  }

  function release(generation: number): void {
    if (generationRef.current !== generation) {
      return;
    }
    busyRef.current = false;
    if (abortRef.current !== null) {
      abortRef.current = null;
    }
  }

  async function discard(): Promise<void> {
    if (!savedUpload || busyRef.current) return;
    cancel();
    const generation = generationRef.current;
    busyRef.current = true;
    setPhase({ status: "discarding" });
    try {
      await multipartApi.abort(project.id, savedUpload.uploadSessionId);
      await uploadState.remove(scope);
      if (!isCurrent(generation)) return;
      setSavedUpload(null);
      selectedFile.current = null;
      setPhase({ status: "cancelled" });
    } catch (error) {
      applyPhase(generation, {
        status: "error",
        message: error instanceof Error ? error.message : "The upload could not be discarded.",
      });
    } finally {
      release(generation);
    }
  }
  function cancel(): void {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    abortDetails();
    busyRef.current = false;
    if (mountedRef.current) {
      setPhase((current) =>
        current.status === "resumable"
          ? {
              ...current,
              transfer: {
                ...current.transfer,
                loaded: current.transfer.durableLoaded,
                percent: Math.min(
                  99.9,
                  (current.transfer.durableLoaded / current.transfer.total) * 100,
                ),
                stage: "paused",
                speed: 0,
                eta: null,
              },
            }
          : { status: "cancelled" },
      );
      setRefreshing(false);
    }
  }

  return (
    <div className="mt-6 min-w-0">
      {savedUpload ? (
        <div className="mb-4 rounded-lg border border-line p-4" aria-live="polite">
          <p className="text-sm">
            Resume {savedUpload.filename}. Reselect the same video to verify its SHA-256 and upload
            only missing parts.
          </p>
          {!busyRef.current && selectedFile.current ? (
            <Button
              variant="secondary"
              onClick={() => void acceptFile(selectedFile.current ?? undefined)}
            >
              Resume upload
            </Button>
          ) : null}
          {!busyRef.current ? (
            <Button variant="secondary" onClick={() => void discard()}>
              Discard resumable upload
            </Button>
          ) : null}
        </div>
      ) : null}
      {canUpload ? (
        <UploadDropZone
          busy={busyRef.current || isBusy(phase)}
          dragOver={dragOver}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            const file = event.dataTransfer.files[0];
            void acceptFile(file);
          }}
          onFile={(file) => void acceptFile(file)}
        />
      ) : (
        <p className="text-sm text-muted">
          Only an Owner or Editor can upload media. You can view details for an upload started in
          this visit. Earlier uploads are not listed here.
        </p>
      )}
      <UploadStatus
        phase={phase}
        busy={busyRef.current}
        onCancel={cancel}
        onReset={() => setPhase({ status: "idle" })}
      />
      {phase.status === "uploaded" ? (
        <>
          <MediaJobProgress
            projectId={project.id}
            mediaId={phase.details.id}
            canRetry={canUpload}
            onTerminal={() => void refresh(phase.details.id, generationRef.current)}
            api={jobApi}
            stream={jobStream}
          />
          <MediaDetailsPanel
            details={phase.details}
            refreshing={refreshing}
            refreshError={refreshError}
            onRefresh={() => void refresh(phase.details.id, generationRef.current)}
          />
        </>
      ) : null}
    </div>
  );
}

function isBusy(phase: Phase): boolean {
  return (
    (phase.status === "resumable" &&
      ["resuming", "uploading", "completing"].includes(phase.transfer.stage)) ||
    phase.status === "hashing" ||
    phase.status === "requesting-upload" ||
    phase.status === "uploading" ||
    phase.status === "completing" ||
    phase.status === "discarding"
  );
}

function UploadDropZone({
  busy,
  dragOver,
  onDragOver,
  onDragLeave,
  onDrop,
  onFile,
}: {
  busy: boolean;
  dragOver: boolean;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onFile: (file: File | undefined) => void;
}) {
  return (
    <div
      className={`min-w-0 rounded-lg border border-dashed p-6 ${dragOver ? "border-accent" : "border-line"}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <p className="text-sm font-medium">Drop a video here</p>
      <p className="mt-1 text-sm text-muted">MP4, MOV, MKV, or WebM. Up to 4 GiB.</p>
      <label
        className="mt-4 inline-flex cursor-pointer rounded-md border border-line px-3 py-2 text-sm"
        htmlFor="media-file"
      >
        Choose a video
        <input
          id="media-file"
          className="sr-only"
          type="file"
          accept="video/mp4,video/quicktime,video/x-matroska,video/webm,.mp4,.mov,.mkv,.webm"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            onFile(file);
          }}
        />
      </label>
    </div>
  );
}

function UploadStatus({
  phase,
  busy,
  onCancel,
  onReset,
}: {
  phase: Phase;
  busy: boolean;
  onCancel: () => void;
  onReset: () => void;
}) {
  if (phase.status === "idle") {
    return null;
  }
  const progress = progressOf(phase);
  return (
    <div className="mt-4 min-w-0" aria-live="polite">
      {"name" in phase ? (
        <p className="overflow-anywhere text-sm">
          {phase.name} {"size" in phase ? `· ${formatBytes(phase.size)}` : ""}
        </p>
      ) : null}
      <p className="mt-1 text-sm text-muted">{statusText(phase)}</p>
      {progress !== null ? (
        <progress className="mt-2 w-full" value={progress.loaded} max={progress.total} />
      ) : null}
      {phase.status === "resumable" ? (
        <p className="mt-2 text-sm text-muted">
          {phase.transfer.percent.toFixed(1)}% · {formatBytes(phase.transfer.loaded)} /{" "}
          {formatBytes(phase.transfer.total)} · {formatBytes(phase.transfer.speed)}/s ·{" "}
          {phase.transfer.eta === null
            ? "Remaining time unavailable"
            : `${Math.ceil(phase.transfer.eta)}s remaining`}
        </p>
      ) : null}
      {phase.status === "hashing" ||
      phase.status === "uploading" ||
      (phase.status === "resumable" && busy) ? (
        <Button className="mt-3" variant="secondary" onClick={onCancel}>
          {phase.status === "resumable" ? "Pause upload" : "Cancel"}
        </Button>
      ) : null}
      {phase.status === "error" ? (
        <p className="overflow-anywhere mt-2 text-sm text-danger" role="alert">
          {phase.message}
        </p>
      ) : null}
      {phase.status === "error" || phase.status === "cancelled" ? (
        <Button className="mt-3" variant="secondary" onClick={onReset}>
          Choose another file
        </Button>
      ) : null}
      {phase.status === "uploaded" ? (
        <p className="mt-2 text-sm text-paper">
          Upload complete. The video was not sent through the application server.
        </p>
      ) : null}
    </div>
  );
}

function progressOf(phase: Phase): { loaded: number; total: number } | null {
  if (phase.status === "resumable")
    return {
      loaded: (phase.transfer.percent / 100) * phase.transfer.total,
      total: phase.transfer.total,
    };
  if (phase.status === "hashing" || phase.status === "uploading") {
    if (phase.total <= 0) {
      return null;
    }
    return { loaded: phase.loaded, total: phase.total };
  }
  return null;
}

function statusText(phase: Phase): string {
  switch (phase.status) {
    case "resumable":
      return {
        resuming: "Resuming verified parts.",
        uploading: "Uploading directly to object storage.",
        paused: "Paused / interrupted. Completed parts are saved.",
        completing: "Completing and verifying SHA-256.",
        completed: "Upload complete.",
      }[phase.transfer.stage];
    case "hashing":
      return "Calculating SHA-256.";
    case "requesting-upload":
      return "Requesting an upload URL.";
    case "uploading":
      return "Uploading directly to object storage.";
    case "completing":
      return "Confirming the stored object.";
    case "uploaded":
      return "The upload is recorded.";
    case "discarding":
      return "Discarding the saved upload.";
    case "cancelled":
      return "The upload was cancelled.";
    case "error":
      return "The file was not uploaded.";
    default:
      return "";
  }
}

function putFailure(status: number): string {
  if (status === 403) {
    return "The upload signature was rejected.";
  }
  if (status === 400) {
    return "The upload checksum was rejected.";
  }
  if (status === 0) {
    return "The small-file upload was interrupted. Choose the file to retry.";
  }
  return "The upload was not accepted by object storage.";
}

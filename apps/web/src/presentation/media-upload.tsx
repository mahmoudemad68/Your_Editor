"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import type {
  MediaDetails,
  ProjectApi,
  ProjectRecord,
  UploadDeclaration,
} from "../project-contract";
import { hashBlob, type HashOptions } from "./sha256-file";
import { MediaDetailsPanel } from "./media-details";
import { putSignedObject, type SignedPutRequest, type SignedPutResult } from "./signed-upload";
import { Button } from "./ui/button";
import { formatBytes, validateMediaFile } from "./upload-policy";

type Phase =
  | { status: "idle" }
  | { status: "hashing"; name: string; size: number; loaded: number; total: number }
  | { status: "requesting-upload"; name: string; size: number }
  | { status: "uploading"; name: string; size: number; loaded: number; total: number }
  | { status: "completing"; name: string; size: number }
  | { status: "uploaded"; name: string; details: MediaDetails }
  | { status: "error"; message: string }
  | { status: "cancelled" };

export function MediaWorkspace({
  project,
  api,
  hashFile = hashBlob,
  putObject = putSignedObject,
}: {
  project: ProjectRecord;
  api: ProjectApi;
  hashFile?: (file: Blob, options?: HashOptions) => Promise<string>;
  putObject?: (request: SignedPutRequest) => Promise<SignedPutResult>;
}) {
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
  const canUpload = project.role === "owner" || project.role === "editor";
  const pendingAssetId =
    phase.status === "uploaded" && phase.details.inspectionStatus === "pending"
      ? phase.details.id
      : null;

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

  useEffect(() => {
    if (pendingAssetId === null) {
      return;
    }
    const generation = generationRef.current;
    let stopped = false;
    void (async () => {
      for (let attempt = 1; attempt <= 8 && !stopped; attempt += 1) {
        await wait(2000);
        if (stopped || !isCurrent(generation)) {
          return;
        }
        await refresh(pendingAssetId, generation);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [pendingAssetId]);

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

  function cancel(): void {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    abortDetails();
    busyRef.current = false;
    if (mountedRef.current) {
      setPhase({ status: "cancelled" });
      setRefreshing(false);
    }
  }

  return (
    <div className="mt-6 min-w-0">
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
      <UploadStatus phase={phase} onCancel={cancel} onReset={() => setPhase({ status: "idle" })} />
      {phase.status === "uploaded" ? (
        <MediaDetailsPanel
          details={phase.details}
          refreshing={refreshing}
          refreshError={refreshError}
          onRefresh={() => void refresh(phase.details.id, generationRef.current)}
        />
      ) : null}
    </div>
  );
}

function isBusy(phase: Phase): boolean {
  return (
    phase.status === "hashing" ||
    phase.status === "requesting-upload" ||
    phase.status === "uploading" ||
    phase.status === "completing"
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
  onCancel,
  onReset,
}: {
  phase: Phase;
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
      {phase.status === "hashing" || phase.status === "uploading" ? (
        <Button className="mt-3" variant="secondary" onClick={onCancel}>
          Cancel
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
    case "cancelled":
      return "The upload was cancelled. It was not resumed.";
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
    return "The upload was interrupted. Start it again. Resume is not available yet.";
  }
  return "The upload was not accepted by object storage.";
}

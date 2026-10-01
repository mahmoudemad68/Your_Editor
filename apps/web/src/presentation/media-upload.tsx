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

const BUSY = new Set(["hashing", "requesting-upload", "uploading", "completing"]);

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
  const [dragOver, setDragOver] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const canUpload = project.role === "owner" || project.role === "editor";
  busyRef.current = BUSY.has(phase.status);
  const pendingAssetId =
    phase.status === "uploaded" && phase.details.inspectionStatus === "pending"
      ? phase.details.id
      : null;

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (pendingAssetId === null) {
      return;
    }
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (attempts > 8) {
        clearInterval(timer);
        return;
      }
      void refresh(pendingAssetId);
    }, 2000);
    return () => clearInterval(timer);
  }, [pendingAssetId]);

  async function refresh(mediaAssetId: string): Promise<void> {
    setRefreshing(true);
    const result = await api.getMediaDetails(project.id, mediaAssetId);
    setRefreshing(false);
    if (!result.ok) {
      return;
    }
    setPhase((current) =>
      current.status === "uploaded"
        ? { status: "uploaded", name: current.name, details: result.data }
        : current,
    );
  }

  async function acceptFile(file: File | undefined): Promise<void> {
    if (file === undefined || !canUpload || busyRef.current) {
      return;
    }
    const validation = validateMediaFile(file);
    if ("error" in validation) {
      setPhase({ status: "error", message: validation.error });
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const declarationBase = {
      filename: file.name,
      mimeType: validation.mimeType,
      byteSize: file.size,
    };
    try {
      setPhase({
        status: "hashing",
        name: file.name,
        size: file.size,
        loaded: 0,
        total: file.size,
      });
      const sha256 = await hashFile(file, {
        signal: controller.signal,
        onProgress: (loaded, total) => {
          setPhase({ status: "hashing", name: file.name, size: file.size, loaded, total });
        },
      });
      if (controller.signal.aborted) {
        setPhase({ status: "cancelled" });
        return;
      }
      const declaration: UploadDeclaration = { ...declarationBase, sha256 };
      setPhase({ status: "requesting-upload", name: file.name, size: file.size });
      const started = await api.beginUpload(project.id, declaration);
      if (!started.ok) {
        setPhase({ status: "error", message: started.message });
        return;
      }
      setPhase({
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
          setPhase({
            status: "uploading",
            name: file.name,
            size: file.size,
            loaded,
            total: total > 0 ? total : file.size,
          });
        },
      });
      if (put.status === 412) {
        await finishAfterConditionalPut(declaration, file.name);
        return;
      }
      if (!put.ok) {
        setPhase({ status: "error", message: putFailure(put.status) });
        return;
      }
      await finishUpload(declaration, file.name);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setPhase({ status: "cancelled" });
        return;
      }
      setPhase({
        status: "error",
        message: error instanceof Error ? error.message : "The upload failed.",
      });
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }

  async function finishAfterConditionalPut(
    declaration: UploadDeclaration,
    name: string,
  ): Promise<void> {
    setPhase({ status: "completing", name, size: declaration.byteSize });
    const completed = await api.completeUpload(project.id, declaration);
    if (!completed.ok) {
      setPhase({
        status: "error",
        message:
          completed.status === 409
            ? completed.message
            : "The existing object was not verified. Nothing was overwritten.",
      });
      return;
    }
    await loadDetails(completed.data.id, name);
  }

  async function finishUpload(declaration: UploadDeclaration, name: string): Promise<void> {
    setPhase({ status: "completing", name, size: declaration.byteSize });
    const completed = await api.completeUpload(project.id, declaration);
    if (!completed.ok) {
      setPhase({ status: "error", message: completed.message });
      return;
    }
    await loadDetails(completed.data.id, name);
  }

  async function loadDetails(mediaAssetId: string, name: string): Promise<void> {
    const details = await api.getMediaDetails(project.id, mediaAssetId);
    if (!details.ok) {
      setPhase({ status: "error", message: details.message });
      return;
    }
    setPhase({ status: "uploaded", name, details: details.data });
  }

  function cancel(): void {
    abortRef.current?.abort();
  }

  return (
    <div className="mt-6 min-w-0">
      {canUpload ? (
        <UploadDropZone
          busy={BUSY.has(phase.status)}
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
          onRefresh={() => void refresh(phase.details.id)}
        />
      ) : null}
    </div>
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

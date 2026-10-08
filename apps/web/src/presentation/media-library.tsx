"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LibraryItem,
  MediaLibraryApi,
  MediaPreview,
  SpriteLayout,
} from "../media-library-contract";
import type { JobEventStream } from "../job-contract";
import { projectJobEvents } from "./job-event-stream";
import { browserMediaLibraryApi } from "./media-library-api";
import { Button } from "./ui/button";

export function formatDuration(duration: string | null): string {
  if (duration === null || !/^[0-9]+$/.test(duration)) return "Duration unavailable";
  const seconds = BigInt(duration) / 1_000_000n;
  return `${seconds / 60n}:${(seconds % 60n).toString().padStart(2, "0")}`;
}

export function libraryStatus(item: LibraryItem): "Failed" | "Processing" | "Ready" {
  if (item.validationStatus === "rejected" || item.inspectionStatus === "failed") return "Failed";
  return item.inspectionStatus === "completed" &&
    item.validationStatus === "validated" &&
    item.previews.proxy &&
    item.previews.poster &&
    item.previews.sprite
    ? "Ready"
    : "Processing";
}

export function spriteFrame(normalizedX: number, layout: SpriteLayout) {
  const count = layout.timestampsUs.length;
  const index = Math.min(count - 1, Math.floor(Math.max(0, Math.min(1, normalizedX)) * count));
  return { index, column: index % layout.columns, row: Math.floor(index / layout.columns) };
}

/** Durable snapshot on mount/upload/reconnect/Job state changes. One shared Project SSE. */
export function MediaLibrary({
  projectId,
  refreshToken = 0,
  api = browserMediaLibraryApi,
  stream = projectJobEvents,
}: {
  projectId: string;
  refreshToken?: number;
  api?: MediaLibraryApi;
  stream?: JobEventStream;
}) {
  const [items, setItems] = useState<readonly LibraryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;
    const result = await api.listMedia(projectId, { signal: request.signal });
    if (request.signal.aborted) return;
    if (result.ok) {
      setItems(result.data);
      setError(null);
    } else {
      setError(result.message);
    }
  }, [api, projectId]);
  useEffect(() => {
    setItems(null);
    void load();
    return () => requestRef.current?.abort();
  }, [load]);
  useEffect(() => {
    if (refreshToken > 0) void load();
  }, [refreshToken, load]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reconcile = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 200);
    };
    const stop = stream.subscribe(projectId, {
      reconcile,
      event: (event) => {
        if (["media.inspect", "media.derive"].includes(event.jobType) && event.kind === "state")
          reconcile();
      },
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [stream, projectId, load]);
  return (
    <section className="mt-8 min-w-0" aria-label="Media Library">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Media Library</h2>
        <Button variant="secondary" onClick={() => void load()}>
          Refresh library
        </Button>
      </div>
      {error ? (
        <p className="mt-3 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {items === null && !error ? (
        <p className="mt-4 text-sm text-muted" aria-busy="true">
          Loading media…
        </p>
      ) : null}
      {items?.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-line p-6 text-sm text-muted">
          No media yet. Upload a video to get started.
        </p>
      ) : null}
      <div className="mt-4 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {items?.map((item) => (
          <MediaCard key={item.id} projectId={projectId} item={item} api={api} />
        ))}
      </div>
    </section>
  );
}

export function MediaCard({
  projectId,
  item,
  api,
}: {
  projectId: string;
  item: LibraryItem;
  api: MediaLibraryApi;
}) {
  const status = libraryStatus(item);
  const filename = item.displayFilename ?? "Untitled media";
  const [preview, setPreview] = useState<MediaPreview | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [spriteRequested, setSpriteRequested] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const [spriteFailed, setSpriteFailed] = useState(false);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playerVersion, setPlayerVersion] = useState(0);
  const expiresAt = useRef(0);
  const requestRef = useRef<AbortController | null>(null);
  const imageRetry = useRef(false);
  const playerRetry = useRef(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playback = useRef({ time: 0, playing: false });
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;
    setLoading(true);
    const result = await api.getMediaPreview(projectId, item.id, { signal: request.signal });
    if (!mounted.current || request.signal.aborted) return false;
    setLoading(false);
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    setPreview(result.data);
    expiresAt.current = Date.now() + Math.max(0, result.data.expiresInSeconds - 30) * 1000;
    setPosterFailed(false);
    setSpriteFailed(false);
    setError(null);
    return result.data.proxy.available;
  }, [api, projectId, item.id]);
  useEffect(() => {
    mounted.current = true;
    if (status === "Ready") void refresh();
    else {
      requestRef.current?.abort();
      setPreview(null);
      setPlayerOpen(false);
    }
    return () => {
      mounted.current = false;
      requestRef.current?.abort();
    };
  }, [status, refresh]);
  async function openPlayer() {
    setPlayerOpen(false);
    playerRetry.current = false;
    playback.current = { time: 0, playing: false };
    if (await refresh()) {
      setPlayerVersion((n) => n + 1);
      setPlayerOpen(true);
    }
  }
  async function retryPlayer() {
    if (playerRetry.current) {
      setError("Playback could not load. Refresh previews to try again.");
      return;
    }
    playerRetry.current = true;
    playback.current = {
      time: videoRef.current?.currentTime ?? 0,
      playing: !(videoRef.current?.paused ?? true),
    };
    if (await refresh()) setPlayerVersion((n) => n + 1);
  }
  function imageError(kind: "poster" | "sprite") {
    if (kind === "poster") setPosterFailed(true);
    else setSpriteFailed(true);
    if (!imageRetry.current) {
      imageRetry.current = true;
      void refresh();
    }
  }
  const layout = preview?.sprite.layout;
  const frame = layout && hover !== null ? spriteFrame(hover, layout) : null;
  const reason =
    item.validationStatus === "rejected"
      ? (item.rejectionMessage ?? "Media was rejected.")
      : item.inspectionStatus === "failed"
        ? `Inspection failed${item.inspectionError ? `: ${item.inspectionError}` : "."}`
        : null;
  return (
    <article
      className="min-w-0 overflow-hidden rounded-lg border border-line bg-panel"
      aria-label={filename}
      data-library-media-id={item.id}
    >
      <button
        type="button"
        disabled={status !== "Ready" || loading}
        aria-label={`Play proxy for ${filename}`}
        className="relative block aspect-video w-full overflow-hidden bg-black focus-visible:outline-offset-[-3px] disabled:cursor-default"
        onClick={() => void openPlayer()}
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch" && status === "Ready") {
            setSpriteRequested(true);
            if (Date.now() >= expiresAt.current) void refresh();
          }
        }}
        onPointerMove={(event) => {
          if (event.pointerType === "touch" || status !== "Ready") return;
          setSpriteRequested(true);
          const rect = event.currentTarget.getBoundingClientRect();
          if (rect.width > 0)
            setHover(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)));
        }}
        onPointerLeave={() => setHover(null)}
      >
        {preview?.poster.url && !posterFailed ? (
          // Real private US-128 JPEG; direct object GET, never a Next image proxy.
          <img
            className="absolute inset-0 h-full w-full object-contain"
            src={preview.poster.url}
            alt={`Thumbnail for ${filename}`}
            onError={() => imageError("poster")}
          />
        ) : (
          <span className="text-sm text-muted">
            {status === "Processing"
              ? "Preparing preview…"
              : status === "Failed"
                ? "Preview unavailable"
                : "Thumbnail unavailable"}
          </span>
        )}
        {spriteRequested && preview?.sprite.url && layout && !spriteFailed ? (
          // One sheet stays mounted; pointer movement only changes the displayed cell.
          <img
            alt=""
            aria-hidden="true"
            src={preview.sprite.url}
            onError={() => imageError("sprite")}
            data-sprite-sample={frame?.index}
            className="pointer-events-none absolute max-w-none"
            style={{
              display: frame ? "block" : "none",
              width: `${layout.columns * 100}%`,
              height: `${layout.rows * 100}%`,
              left: `${-(frame?.column ?? 0) * 100}%`,
              top: `${-(frame?.row ?? 0) * 100}%`,
            }}
          />
        ) : null}
        <span className="absolute right-2 bottom-2 rounded bg-black/80 px-2 py-1 text-xs text-white">
          {formatDuration(item.duration)}
        </span>
      </button>
      <div className="p-3">
        <h3 className="overflow-anywhere text-sm font-medium">{filename}</h3>
        <p
          className={`mt-2 text-xs ${status === "Failed" ? "text-danger" : "text-muted"}`}
          aria-live="polite"
        >
          <span className="rounded border border-line px-2 py-1">{status}</span>
        </p>
        {status === "Processing" ? (
          <p className="mt-3 text-xs text-muted">
            {item.inspectionStatus === "pending"
              ? "Awaiting inspection and validation."
              : item.validationStatus === "pending"
                ? "Awaiting validation."
                : "Awaiting preview derivatives."}
          </p>
        ) : null}
        {reason ? <p className="overflow-anywhere mt-3 text-sm text-danger">{reason}</p> : null}
        {error ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        ) : null}
        {status === "Ready" ? (
          <Button
            className="mt-3"
            variant="secondary"
            disabled={loading}
            onClick={() => {
              imageRetry.current = false;
              playerRetry.current = false;
              void refresh().then(() => setPlayerVersion((n) => n + 1));
            }}
          >
            Refresh previews
          </Button>
        ) : null}
        {playerOpen && preview?.proxy.url ? (
          <div className="mt-3">
            <video
              key={playerVersion}
              ref={videoRef}
              controls
              preload="metadata"
              playsInline
              aria-label={`Proxy player for ${filename}`}
              className="aspect-video w-full bg-black"
              src={preview.proxy.url}
              onError={() => void retryPlayer()}
              onLoadedMetadata={() => {
                const video = videoRef.current;
                if (video && playback.current.time > 0)
                  video.currentTime = Math.min(playback.current.time, video.duration);
                if (video && playback.current.playing) void video.play().catch(() => {});
              }}
            />
            <Button className="mt-2" variant="secondary" onClick={() => setPlayerOpen(false)}>
              Close player
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorDownload, EditorRender, EditorTimeline } from "../editor-contract";
import type { ApiResult } from "../project-contract";
import type { JobEventStream } from "../job-contract";
import { browserEditorApi, type EditorApi } from "./editor-api";
import { projectJobEvents } from "./job-event-stream";
import { Button } from "./ui/button";
import { CaptionControls } from "./caption-controls";

export function secondsToUs(text: string): string {
  const match = /^(0|[1-9][0-9]{0,3})(?:\.([0-9]{1,6}))?$/.exec(text);
  if (!match || match[0] !== text)
    throw new Error("Enter non-negative seconds with at most six decimal places.");
  return String(BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0")));
}
function seconds(value: string) {
  const us = BigInt(value);
  return `${us / 1_000_000n}.${String(us % 1_000_000n).padStart(6, "0")}`.replace(/\.?0+$/, "");
}
const terminal = (job: EditorRender | null) =>
  job && ["Completed", "Failed", "Cancelled"].includes(job.status);

export function ManualEditor({
  projectId,
  mediaId,
  initialTimelineId,
  api = browserEditorApi,
  stream = projectJobEvents,
}: {
  projectId: string;
  mediaId?: string;
  initialTimelineId?: string;
  api?: EditorApi;
  stream?: JobEventStream;
}) {
  const [stored, setStored] = useState<EditorTimeline | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [start, setStart] = useState("0"),
    [end, setEnd] = useState("0"),
    [split, setSplit] = useState("0");
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const [job, setJob] = useState<EditorRender | null>(null);
  const [download, setDownload] = useState<EditorDownload | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const active = useRef<AbortController | null>(null);
  const renderRequest = useRef<string | null>(null);
  const clips = stored?.timeline.tracks.flatMap((t) => t.clips) ?? [];
  const clip = clips.find((c) => c.id === selected) ?? clips[0];
  const clipId = clip?.id,
    clipIn = clip?.inPoint,
    clipOut = clip?.outPoint,
    clipStart = clip?.timelineStartUs;
  const running = Boolean(job && !terminal(job));

  const accept = useCallback(<T,>(result: ApiResult<T>): T | null => {
    if (result.ok) return result.data;
    setError(result.message);
    if ([401, 403, 404].includes(result.status)) {
      setStored(null);
      setJob(null);
      setDownload(null);
    }
    return null;
  }, []);

  const load = useCallback(
    async (id: string) => {
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      setBusy(true);
      setError(null);
      setDownload(null);
      const result = await api.read(projectId, id, controller.signal);
      if (!controller.signal.aborted) {
        const next = accept(result);
        if (next) setStored(next);
        setBusy(false);
      }
    },
    [accept, api, projectId],
  );
  useEffect(() => {
    if (initialTimelineId) void load(initialTimelineId);
    return () => active.current?.abort();
  }, [initialTimelineId, load]);
  useEffect(() => {
    if (!clipId || clipIn === undefined || clipOut === undefined || clipStart === undefined) return;
    const a = BigInt(clipStart),
      b = a + BigInt(clipOut) - BigInt(clipIn);
    setStart(seconds(String(a)));
    setEnd(seconds(String(b)));
    setSplit(seconds(String((a + b) / 2n)));
  }, [clipId, clipIn, clipOut, clipStart]);

  useEffect(() => {
    if (!job || terminal(job)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const result = await api.job(projectId, job.jobId, controller.signal);
      if (controller.signal.aborted) return;
      const next = accept(result);
      if (next) setJob(next);
      if (!next || !terminal(next)) timer = setTimeout(() => void refresh(), 1500);
    };
    timer = setTimeout(() => void refresh(), 500);
    const stop = stream.subscribe(projectId, {
      reconcile: () => {},
      event: (event) => {
        if (event.jobId === job.jobId && event.kind === "progress") setProgress(event.percentage);
      },
    });
    return () => {
      controller.abort();
      clearTimeout(timer);
      stop();
    };
  }, [api, projectId, job?.jobId, job?.status, accept, stream]);

  async function mutate(operation: "create" | "trim" | "split" | "render" | "cancel" | "download") {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError(null);
    const take = <T,>(result: ApiResult<T>) => (controller.signal.aborted ? null : accept(result));
    try {
      if (operation === "create" && mediaId) {
        const next = take(await api.create(projectId, mediaId, controller.signal));
        if (controller.signal.aborted) return;
        if (next) {
          setStored(next);
          const url = new URL(window.location.href);
          url.searchParams.set("timeline", next.timeline.id);
          window.history.replaceState(null, "", url);
        }
      } else if ((operation === "trim" || operation === "split") && stored && clip) {
        const body = {
          stateSha256: stored.stateSha256,
          clipId: clip.id,
          ...(operation === "trim"
            ? { startUs: secondsToUs(start), endUs: secondsToUs(end) }
            : { atUs: secondsToUs(split) }),
        };
        const next = take(
          await api.edit(projectId, stored.timeline.id, operation, body, controller.signal),
        );
        if (!controller.signal.aborted && next) {
          setStored(next);
          setDownload(null);
          setJob(null);
          renderRequest.current = null;
        }
      } else if (operation === "render" && stored) {
        renderRequest.current ??= `req_${crypto.randomUUID().replace(/-/g, "")}`;
        const next = take(
          await api.render(
            projectId,
            stored.timeline.id,
            stored.stateSha256,
            renderRequest.current,
            controller.signal,
          ),
        );
        if (!controller.signal.aborted && next) {
          setJob(next);
          setDownload(null);
          setProgress(null);
          renderRequest.current = null;
        }
      } else if (operation === "cancel" && job) {
        const next = take(await api.cancel(projectId, job.jobId, controller.signal));
        if (!controller.signal.aborted && next) setJob(next);
      } else if (operation === "download" && job?.status === "Completed") {
        const next = take(await api.download(projectId, job.jobId, controller.signal));
        if (!controller.signal.aborted && next) setDownload(next);
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setError(error instanceof Error ? error.message : "The edit could not be completed.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <main className="min-w-0 px-4 py-6 md:px-8">
      <a href={`/projects/${encodeURIComponent(projectId)}`} className="text-sm text-muted">
        Back to media and analysis
      </a>
      <h1 className="mt-4 text-2xl font-semibold">Timeline editor</h1>
      {error ? (
        <p role="alert" className="mt-3 text-danger">
          {error}
        </p>
      ) : null}
      {!stored ? (
        <Button className="mt-4" disabled={busy || !mediaId} onClick={() => void mutate("create")}>
          Create timeline from video
        </Button>
      ) : (
        <>
          <section
            aria-label="Timeline"
            className="mt-6 rounded-lg border border-line p-4"
            data-timeline-id={stored.timeline.id}
            data-timeline-sha256={stored.stateSha256}
          >
            <div className="flex flex-wrap justify-between gap-3">
              <h2 className="font-semibold">Saved timeline</h2>
              <span>
                {seconds(stored.timeline.composition.durationUs)} seconds ·{" "}
                {stored.timeline.composition.width} × {stored.timeline.composition.height}
              </span>
            </div>
            <div className="mt-4 flex min-h-16 gap-1 overflow-x-auto">
              {clips.map((item, index) => (
                <button
                  key={item.id}
                  data-clip-id={item.id}
                  aria-pressed={clip?.id === item.id}
                  onClick={() => setSelected(item.id)}
                  className={`min-w-24 rounded border p-3 text-left text-sm ${clip?.id === item.id ? "border-paper bg-panel" : "border-line"}`}
                >
                  Clip {index + 1}
                  <br />
                  Source {seconds(item.inPoint)}–{seconds(item.outPoint)} s<br />
                  At {seconds(item.timelineStartUs)} s
                </button>
              ))}
            </div>
            <p className="mt-3 text-sm text-muted">
              Trim preserves clip placement and composition duration. Empty ranges render as black.
            </p>
            {clip ? (
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <label className="text-sm">
                  Trim start (timeline seconds)
                  <input
                    className="mt-1 block rounded border border-line bg-ink p-2"
                    inputMode="decimal"
                    value={start}
                    disabled={busy || running}
                    onChange={(e) => setStart(e.target.value)}
                  />
                </label>
                <label className="text-sm">
                  Trim end (timeline seconds)
                  <input
                    className="mt-1 block rounded border border-line bg-ink p-2"
                    inputMode="decimal"
                    value={end}
                    disabled={busy || running}
                    onChange={(e) => setEnd(e.target.value)}
                  />
                </label>
                <Button disabled={busy || running} onClick={() => void mutate("trim")}>
                  Apply trim
                </Button>
                <label className="text-sm">
                  Split at (timeline seconds)
                  <input
                    className="mt-1 block rounded border border-line bg-ink p-2"
                    inputMode="decimal"
                    value={split}
                    disabled={busy || running}
                    onChange={(e) => setSplit(e.target.value)}
                  />
                </label>
                <Button disabled={busy || running} onClick={() => void mutate("split")}>
                  Split clip
                </Button>
              </div>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-3">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void load(stored.timeline.id)}
              >
                Reload saved timeline
              </Button>
              <Button disabled={busy || running} onClick={() => void mutate("render")}>
                Render saved timeline
              </Button>
            </div>
          </section>
          <CaptionControls
            projectId={projectId}
            stored={stored}
            assetId={clip?.sourceId ?? null}
            disabled={busy || running}
            onBusyChange={setBusy}
            onUnavailable={() => {
              setStored(null);
              setJob(null);
              setDownload(null);
            }}
            onSaved={(next) => {
              setStored(next);
              setDownload(null);
              setJob(null);
            }}
          />
          {job ? (
            <section
              aria-label="Export job"
              className="mt-6 rounded-lg border border-line p-4"
              data-export-job-id={job.jobId}
            >
              <h2 className="font-semibold">Export</h2>
              <p role="status">
                {job.status}
                {running && progress !== null ? ` · ${progress}%` : ""}
              </p>
              {running ? (
                <Button variant="secondary" disabled={busy} onClick={() => void mutate("cancel")}>
                  Cancel render
                </Button>
              ) : null}
              {job.status === "Failed" ? (
                <p>The render failed. Reload the timeline and start a new render.</p>
              ) : null}
              {job.status === "Completed" ? (
                <Button className="mt-3" disabled={busy} onClick={() => void mutate("download")}>
                  Open export
                </Button>
              ) : null}
              {download ? (
                <div className="mt-4">
                  <video
                    aria-label="Rendered export"
                    className="w-full max-w-3xl"
                    controls
                    preload="metadata"
                    src={download.previewUrl}
                  />
                  <a
                    className="mt-3 inline-block underline"
                    href={download.downloadUrl}
                    download="export.mp4"
                  >
                    Download MP4
                  </a>
                  <p className="mt-2 text-sm text-muted">
                    Links expire after one minute. Use Open export to refresh them.
                  </p>
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}

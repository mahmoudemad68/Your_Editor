"use client";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { JobProgressStage } from "@editagent/schemas";
import type { JobEventStream, JobStatusApi } from "../job-contract";
import { browserJobStatusApi } from "./job-status-api";
import { projectJobEvents } from "./job-event-stream";
import { InspectionJobState } from "./inspection-job-state";
import { Button } from "./ui/button";
const STAGES: Record<JobProgressStage, string> = {
  staging: "Preparing",
  validating: "Validating",
  probing: "Inspecting media",
  decoding: "Checking media",
  proxy: "Creating proxy",
  asr: "Preparing speech audio",
  mix: "Preparing audio",
  poster: "Creating thumbnail",
  sprite: "Creating preview frames",
  uploading: "Saving derivatives",
  finalizing: "Finalizing",
};
const STATUSES = {
  Queued: "Waiting",
  Running: "Processing",
  Retrying: "Retrying",
  Completed: "Completed",
  Failed: "Failed",
  Cancelled: "Cancelled",
};
export function MediaJobProgress({
  projectId,
  mediaId,
  canRetry,
  onTerminal,
  api = browserJobStatusApi,
  stream = projectJobEvents,
}: {
  projectId: string;
  mediaId: string;
  canRetry: boolean;
  onTerminal: () => void;
  api?: JobStatusApi;
  stream?: JobEventStream;
}) {
  const terminalRef = useRef(onTerminal);
  terminalRef.current = onTerminal;
  const controller = useMemo(
    () => new InspectionJobState(projectId, mediaId, api, stream, () => terminalRef.current()),
    [projectId, mediaId, api, stream],
  );
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);
  const job = view.job;
  const active = job && ["Queued", "Running", "Retrying"].includes(job.status);
  const progress = active ? view.progress : null;
  const eligible = job && ["Failed", "Cancelled"].includes(job.status);
  return (
    <section
      className="mt-4 min-w-0 rounded-lg border border-line p-4"
      aria-label="Inspection job"
      data-job-id={job?.jobId}
    >
      <p className="text-sm font-semibold" aria-live="polite">
        <span className="inline-block rounded-md border border-line px-2 py-1">
          {job
            ? STATUSES[job.status]
            : view.loading
              ? "Loading job status…"
              : "Waiting for inspection to be queued"}
        </span>
      </p>
      {progress ? (
        <>
          <p className="mt-2 text-sm">
            {STAGES[progress.stage]} · {Math.round(progress.percentage)}%
          </p>
          <progress
            className="mt-2 w-full"
            aria-label={STAGES[progress.stage]}
            value={progress.percentage}
            max={100}
          />
        </>
      ) : active || !job ? (
        <>
          <p className="mt-2 text-sm text-muted">
            {job?.status === "Queued"
              ? "Waiting to start"
              : job?.status === "Retrying"
                ? "Retrying…"
                : job
                  ? "Processing…"
                  : "Inspection progress is indeterminate."}
          </p>
          <progress className="mt-2 w-full" aria-label="Inspection progress is indeterminate" />
        </>
      ) : null}
      {eligible ? (
        <p className="mt-2 text-sm text-danger">
          {job.status === "Failed" ? "Processing failed." : "Processing was cancelled."}
        </p>
      ) : null}
      {eligible && canRetry ? (
        <Button
          className="mt-3"
          variant="secondary"
          disabled={view.retrying}
          aria-busy={view.retrying}
          onClick={() => void controller.retry()}
        >
          {view.retrying ? "Queuing retry…" : "Retry"}
        </Button>
      ) : null}
      {(!job || view.error) && !view.loading ? (
        <Button className="mt-3" variant="secondary" onClick={() => void controller.reconcile()}>
          Refresh job status
        </Button>
      ) : null}
      {view.error ? (
        <p className="mt-2 text-sm text-danger" role="alert">
          {view.error}
        </p>
      ) : null}
    </section>
  );
}

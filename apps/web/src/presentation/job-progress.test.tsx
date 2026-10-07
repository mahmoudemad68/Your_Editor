import "./dom-setup";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { JobEvent } from "@editagent/schemas";
import type { InspectionJob, JobEventStream, JobStatusApi } from "../job-contract";
import { MediaJobProgress } from "./job-progress";
import { InspectionJobState } from "./inspection-job-state";
const PROJECT = "018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f",
  JOB = "018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4f",
  NEXT = "018f6b6e-7c3a-7b2d-8d3e-9c0b1a2d3e4f";
const snapshot = (status: InspectionJob["status"] = "Queued", jobId = JOB): InspectionJob => ({
  jobId,
  jobType: "media.inspect",
  status,
  attempt: status === "Queued" ? 0 : 1,
  reason: status === "Failed" ? "processing_failed" : null,
  createdAt: jobId === JOB ? "100" : "200",
  updatedAt: "200",
  sequence: 0,
});
function state(
  sequence: number,
  status: InspectionJob["status"],
  attempt = 1,
  jobId = JOB,
): JobEvent {
  return {
    schemaVersion: 1,
    eventId: `${jobId}:${sequence}`,
    jobId,
    projectId: PROJECT,
    jobType: "media.inspect",
    sequence,
    attempt,
    occurredAt: new Date().toISOString(),
    kind: "state",
    status,
  };
}
function progress(
  sequence: number,
  percentage: number,
  stage: "proxy" | "staging" | "finalizing" = "proxy",
  attempt = 1,
  jobId = JOB,
): JobEvent {
  return {
    ...state(sequence, "Running", attempt, jobId),
    kind: "progress",
    percentage,
    stage,
  } as JobEvent;
}
class Stream implements JobEventStream {
  listener?: Parameters<JobEventStream["subscribe"]>[1];
  closed = 0;
  subscribe(_project: string, listener: Parameters<JobEventStream["subscribe"]>[1]) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
      this.closed++;
    };
  }
  async emit(event: JobEvent) {
    await act(async () => this.listener?.event(event));
  }
}
function fixture(status: InspectionJob["status"] = "Queued", canRetry = true) {
  const stream = new Stream();
  let current = snapshot(status),
    retries = 0,
    terminals = 0;
  const api: JobStatusApi = {
    snapshot: async () => current,
    retry: async () => {
      retries++;
      current = snapshot("Queued", NEXT);
      return current;
    },
  };
  const result = render(
    <MediaJobProgress
      projectId={PROJECT}
      mediaId="media"
      canRetry={canRetry}
      api={api}
      stream={stream}
      onTerminal={() => {
        terminals++;
      }}
    />,
  );
  return {
    stream,
    api,
    result,
    current: (job: InspectionJob) => {
      current = job;
    },
    retries: () => retries,
    terminals: () => terminals,
  };
}
afterEach(cleanup);
test("live stage/percentage and terminal DOM changes without reload, with explicit indeterminate start", async () => {
  const f = fixture();
  await screen.findByText("Waiting to start");
  await f.stream.emit(state(1, "Running"));
  assert.ok(screen.getByText("Processing…"));
  assert.equal(screen.getByRole("progressbar").hasAttribute("value"), false);
  for (const [seq, percent, stage, label] of [
    [2, 0, "staging", "Preparing"],
    [3, 25, "proxy", "Creating proxy"],
    [4, 75, "proxy", "Creating proxy"],
    [5, 100, "finalizing", "Finalizing"],
  ] as const) {
    await f.stream.emit(progress(seq, percent, stage));
    assert.ok(screen.getByText(`${label} · ${percent}%`));
  }
  await f.stream.emit(state(6, "Completed"));
  assert.ok(screen.getByText("Completed"));
  assert.equal(f.terminals(), 1);
  assert.equal(screen.queryByRole("progressbar"), null);
});
test("failed safe reason and real adapter retry switches Job identity; old Job cannot regress it", async () => {
  const f = fixture("Failed");
  await screen.findByText("Processing failed.");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Waiting to start");
  assert.equal(f.retries(), 1);
  await f.stream.emit(progress(20, 99, "proxy", 1, JOB));
  assert.equal(screen.queryByText("Creating proxy · 99%"), null);
  await f.stream.emit(state(1, "Running", 1, NEXT));
  await f.stream.emit(progress(2, 25, "proxy", 1, NEXT));
  assert.ok(screen.getByText("Creating proxy · 25%"));
});
test("Viewer sees failure without actionable retry; retry errors retain terminal state", async () => {
  const f = fixture("Failed", false);
  await screen.findByText("Processing failed.");
  assert.equal(screen.queryByRole("button", { name: "Retry" }), null);
  f.result.unmount();
  const g = fixture("Cancelled");
  g.api.retry = async () => {
    throw new Error("unsafe internal text");
  };
  await screen.findByText("Processing was cancelled.");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("alert");
  assert.ok(screen.getByText("Processing was cancelled."));
  assert.doesNotMatch(document.body.textContent!, /unsafe/);
});
test("duplicate/out-of-order ignored and cross-attempt 75 to 0 reset accepted", async () => {
  const f = fixture("Running");
  await screen.findByText("Processing…");
  await f.stream.emit(progress(5, 75));
  await f.stream.emit(progress(5, 25));
  await f.stream.emit(progress(4, 0));
  assert.ok(screen.getByText("Creating proxy · 75%"));
  await f.stream.emit(state(6, "Retrying"));
  assert.ok(screen.getByText("Retrying…"));
  await f.stream.emit(state(7, "Running", 2));
  await f.stream.emit(progress(8, 0, "staging", 2));
  assert.ok(screen.getByText("Preparing · 0%"));
});
test("reconnect reconciles authoritative successor and unmount releases stream/snapshot", async () => {
  const f = fixture();
  await screen.findByText("Waiting");
  f.current(snapshot("Completed", NEXT));
  await act(async () => f.stream.listener?.reconcile());
  await screen.findByText("Completed");
  f.result.unmount();
  assert.equal(f.stream.closed, 1);
});
test("snapshot race and pre-snapshot events do not overwrite newer SSE; retry race and cleanup", async () => {
  let resolve!: (job: InspectionJob | null) => void;
  const api: JobStatusApi = {
    snapshot: () =>
      new Promise((r) => {
        resolve = r;
      }),
    retry: async () => snapshot("Queued", NEXT),
  };
  const stream = new Stream();
  const model = new InspectionJobState(PROJECT, "media", api, stream, () => {});
  model.start();
  stream.listener!.event(state(2, "Running"));
  stream.listener!.event(progress(3, 75));
  resolve(snapshot());
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(model.getSnapshot().progress?.percentage, 75);
  const request = model.reconcile();
  stream.listener!.event(state(4, "Completed"));
  resolve(snapshot("Running"));
  await request;
  assert.equal(model.getSnapshot().job?.status, "Completed");
  model.stop();
  assert.equal(stream.closed, 1);
});
test("retry cannot be submitted twice while pending and stale snapshot is invalidated", async () => {
  let finish!: (job: InspectionJob) => void,
    calls = 0;
  const stream = new Stream();
  const api: JobStatusApi = {
    snapshot: async () => snapshot("Failed"),
    retry: () => {
      calls++;
      return new Promise((r) => {
        finish = r;
      });
    },
  };
  render(
    <MediaJobProgress
      projectId={PROJECT}
      mediaId="media"
      canRetry
      api={api}
      stream={stream}
      onTerminal={() => {}}
    />,
  );
  await screen.findByText("Processing failed.");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  assert.equal(screen.getByRole("button").hasAttribute("disabled"), true);
  await act(async () => finish(snapshot("Queued", NEXT)));
  await screen.findByText("Waiting");
  assert.equal(calls, 1);
});

test("trusted retry winner with equal creation time overrides UUID ties; stale predecessor snapshot ignored", async () => {
  const stream = new Stream();
  let current = snapshot("Failed", NEXT);
  const predecessor = { ...current, createdAt: "200" };
  const successor = { ...snapshot("Queued", JOB), createdAt: "200" };
  current = predecessor;
  const api: JobStatusApi = { snapshot: async () => current, retry: async () => successor };
  const model = new InspectionJobState(PROJECT, "media", api, stream, () => {});
  model.start();
  await new Promise((r) => setTimeout(r, 0));
  await model.retry();
  assert.equal(model.getSnapshot().job?.jobId, JOB);
  await model.reconcile();
  assert.equal(model.getSnapshot().job?.jobId, JOB);
  model.stop();
});

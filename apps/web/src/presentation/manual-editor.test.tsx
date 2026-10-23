import "./dom-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ManualEditor, secondsToUs } from "./manual-editor";
import type { EditorApi } from "./editor-api";
import type { EditorTimeline } from "../editor-contract";

const PROJECT = "018f6b6e-7c3a-7000-8000-000000000001";
const ID = "018f6b6e-7c3a-7000-8000-000000000002";
const CLIP = "018f6b6e-7c3a-7000-8000-000000000003";
const fixture = (): EditorTimeline => ({
  stateSha256: "a".repeat(64),
  timeline: {
    id: ID,
    projectId: PROJECT,
    composition: {
      width: 640,
      height: 360,
      durationUs: "2000000",
      frameRate: { numerator: "30", denominator: "1" },
    },
    tracks: [
      {
        id: ID,
        clips: [
          { id: CLIP, sourceId: ID, inPoint: "0", outPoint: "2000000", timelineStartUs: "0" },
        ],
      },
    ],
  },
});
const stream = { subscribe: () => () => {} };
function api(): EditorApi {
  return {
    create: async () => ({ ok: true, data: fixture() }),
    read: async () => ({ ok: true, data: fixture() }),
    edit: async () => ({ ok: true, data: fixture() }),
    render: async () => ({
      ok: true,
      data: { jobId: ID, status: "Completed", attempt: 1, updatedAt: "1" },
    }),
    job: async () => ({
      ok: true,
      data: { jobId: ID, status: "Completed", attempt: 1, updatedAt: "1" },
    }),
    cancel: async () => ({
      ok: true,
      data: { jobId: ID, status: "Cancelled", attempt: 1, updatedAt: "1" },
    }),
    download: async () => ({
      ok: true,
      data: {
        previewUrl: "https://storage.test/preview",
        downloadUrl: "https://storage.test/download",
        expiresInSeconds: 60,
      },
    }),
  };
}

test("manual time entry preserves exact microseconds and rejects ambiguous input", () => {
  assert.equal(secondsToUs("1.000001"), "1000001");
  assert.equal(secondsToUs("0.04"), "40000");
  for (const value of ["-1", "1e3", "01", "1.0000001", "1\n", "Infinity", " 1"])
    assert.throws(() => secondsToUs(value));
});

test("trim submits the saved basis and canonical times; a stale response cannot look applied", async () => {
  cleanup();
  const client = api();
  const calls: unknown[] = [];
  client.edit = async (project, id, operation, body) => {
    calls.push({ project, id, operation, body });
    return { ok: false, status: 409, message: "Reload the timeline." };
  };
  render(<ManualEditor projectId={PROJECT} initialTimelineId={ID} api={client} stream={stream} />);
  await screen.findByRole("region", { name: "Timeline" });
  fireEvent.change(screen.getByLabelText("Trim start (timeline seconds)"), {
    target: { value: "0.300001" },
  });
  fireEvent.change(screen.getByLabelText("Trim end (timeline seconds)"), {
    target: { value: "1.6" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply trim" }));
  await screen.findByRole("alert");
  assert.deepEqual(calls, [
    {
      project: PROJECT,
      id: ID,
      operation: "trim",
      body: {
        stateSha256: "a".repeat(64),
        clipId: CLIP,
        startUs: "300001",
        endUs: "1600000",
      },
    },
  ]);
  assert.equal(
    screen.getByRole("region", { name: "Timeline" }).getAttribute("data-timeline-sha256"),
    "a".repeat(64),
  );
  cleanup();
});

test("a completed export is fetched explicitly and cleared by a subsequent edit", async () => {
  cleanup();
  render(<ManualEditor projectId={PROJECT} initialTimelineId={ID} api={api()} stream={stream} />);
  await screen.findByRole("region", { name: "Timeline" });
  await waitFor(() =>
    assert.equal(
      (screen.getByRole("button", { name: "Render saved timeline" }) as HTMLButtonElement).disabled,
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Render saved timeline" }));
  const open = await screen.findByRole("button", { name: "Open export" });
  await waitFor(() => assert.equal((open as HTMLButtonElement).disabled, false));
  fireEvent.click(open);
  const download = await screen.findByRole("link", { name: "Download MP4" });
  assert.equal(download.getAttribute("href"), "https://storage.test/download");
  await waitFor(() =>
    assert.equal(
      (screen.getByRole("button", { name: "Apply trim" }) as HTMLButtonElement).disabled,
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Apply trim" }));
  await waitFor(() => assert.ok(screen.queryByRole("link", { name: "Download MP4" }) === null));
  assert.equal(screen.queryByRole("region", { name: "Export job" }), null);
  cleanup();
});

test("unmount aborts the timeline read and denied refresh clears previously loaded content", async () => {
  cleanup();
  const pending = api();
  let signal: AbortSignal | undefined;
  pending.read = async (_p, _id, requestSignal) => {
    signal = requestSignal;
    return new Promise<never>(() => {});
  };
  const mounted = render(
    <ManualEditor projectId={PROJECT} initialTimelineId={ID} api={pending} stream={stream} />,
  );
  await waitFor(() => assert.ok(signal));
  mounted.unmount();
  assert.equal(signal?.aborted, true);
  const client = api();
  let reads = 0;
  client.read = async () =>
    ++reads === 1
      ? { ok: true, data: fixture() }
      : { ok: false, status: 403, message: "Access revoked." };
  render(<ManualEditor projectId={PROJECT} initialTimelineId={ID} api={client} stream={stream} />);
  await screen.findByRole("region", { name: "Timeline" });
  fireEvent.click(screen.getByRole("button", { name: "Reload saved timeline" }));
  await screen.findByRole("alert");
  assert.equal(screen.queryByRole("region", { name: "Timeline" }), null);
  cleanup();
});

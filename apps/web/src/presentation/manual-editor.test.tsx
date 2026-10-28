import "./dom-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ManualEditor, secondsToUs } from "./manual-editor";
import type { EditorApi } from "./editor-api";
import type { CaptionStyle, EditorTimeline } from "../editor-contract";
import { CaptionControls } from "./caption-controls";

const PROJECT = "018f6b6e-7c3a-7000-8000-000000000001";
const ID = "018f6b6e-7c3a-7000-8000-000000000002";
const CLIP = "018f6b6e-7c3a-7000-8000-000000000003";
test("caption controls request current evidence and persist through fixed routes without client words", async () => {
  const stored = fixture(),
    calls: { url: string; body: Record<string, unknown> | null }[] = [];
  let saved: EditorTimeline | null = null;
  render(
    <CaptionControls
      projectId={PROJECT}
      stored={stored}
      assetId={ID}
      disabled={false}
      onSaved={(value) => {
        saved = value;
      }}
      api={async <T,>(url: string, options?: RequestInit) => {
        const body = options?.body
          ? (JSON.parse(String(options.body)) as Record<string, unknown>)
          : null;
        calls.push({ url, body });
        return {
          ok: true,
          data: (url.includes("/sources/")
            ? { assetId: ID, sourceSha256: "b".repeat(64), analysisSha256: "c".repeat(64) }
            : stored) as T,
        };
      }}
    />,
  );
  try {
    fireEvent.click(screen.getByRole("button", { name: "Add word-synchronized captions" }));
    await waitFor(() => assert.notEqual(saved, null));
    assert.equal(calls.length, 2);
    assert.ok(calls[0]!.url.endsWith(`/captions/sources/${ID}`));
    assert.ok(calls[1]!.url.endsWith("/captions"));
    assert.equal(calls[1]!.body!.stateSha256, stored.stateSha256);
    assert.equal((calls[1]!.body!.style as CaptionStyle).fontSize, 25);
    assert.match(
      String(calls[1]!.body!.requestId),
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal("words" in calls[1]!.body!, false);
    assert.equal("callerId" in calls[1]!.body!, false);
  } finally {
    cleanup();
  }
});
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
test("caption form restores saved style and preserves fields outside the edited controls", async () => {
  const stored = fixture();
  const original: CaptionStyle = {
    color: "#eeeeee",
    background: "#111111",
    highlight: "#00ff00",
    outline: "#222222",
    outlinePx: 1,
    shadowPx: 2,
    font: "DejaVu Sans",
    fontSize: 20,
    direction: "rtl",
    preset: "landscape",
    marginPermille: 10,
  };
  stored.timeline.captionsV1 = [
    {
      id: CLIP,
      assetId: ID,
      sourceSha256: "b".repeat(64),
      style: original,
      evidence: { kind: "media-analysis", documentSha256: "c".repeat(64), version: "1.1.0" },
      blocks: [
        {
          startUs: "0",
          endUs: "1500000",
          lines: [[{ text: "Hello", startUs: "0", endUs: "1000000", confidence: 0.9 }]],
        },
      ],
    },
  ];
  const originalSnapshot = JSON.stringify(stored);
  let submitted: Record<string, unknown> | null = null;
  const props = {
    projectId: PROJECT,
    stored,
    assetId: ID,
    disabled: false,
    onSaved: () => {},
    api: async <T,>(_url: string, options?: RequestInit) => {
      submitted = JSON.parse(String(options?.body)) as Record<string, unknown>;
      return { ok: true as const, data: stored as T };
    },
  };
  const view = render(<CaptionControls {...props} />);
  try {
    assert.equal(
      (screen.getByLabelText("Caption highlight color") as HTMLInputElement).value,
      "#00ff00",
    );
    assert.equal((screen.getByLabelText("Caption direction") as HTMLSelectElement).value, "rtl");
    fireEvent.change(screen.getByLabelText("Caption highlight color"), {
      target: { value: "#ff00ff" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update caption style" }));
    await waitFor(() => assert.notEqual(submitted, null));
    assert.deepEqual((submitted as unknown as { style: CaptionStyle }).style, {
      ...original,
      highlight: "#ff00ff",
    });
    assert.equal(JSON.stringify(stored), originalSnapshot);
    assert.deepEqual(Object.keys(submitted!).sort(), ["requestId", "stateSha256", "style"]);
    const restored = structuredClone(stored);
    restored.timeline.captionsV1![0]!.style = {
      ...original,
      highlight: "#ffff00",
      direction: "ltr",
    };
    view.rerender(<CaptionControls {...props} stored={restored} />);
    await waitFor(() => {
      assert.equal(
        (screen.getByLabelText("Caption highlight color") as HTMLInputElement).value,
        "#ffff00",
      );
      assert.equal((screen.getByLabelText("Caption direction") as HTMLSelectElement).value, "ltr");
    });
  } finally {
    cleanup();
  }
});
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

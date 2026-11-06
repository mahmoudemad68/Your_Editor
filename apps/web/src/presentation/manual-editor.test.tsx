import "./dom-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ManualEditor, secondsToUs } from "./manual-editor";
import type { EditorApi } from "./editor-api";
import type { CaptionStyle, EditorTimeline } from "../editor-contract";
import { CaptionControls } from "./caption-controls";

const PROJECT = "018f6b6e-7c3a-7000-8000-000000000001";
const ID = "018f6b6e-7c3a-7000-8000-000000000002";
const CLIP = "018f6b6e-7c3a-7000-8000-000000000003";

// Isolate React's official scheduler mock before loading ReactDOM. Stop at the
// first paint, rather than waiting for initialization and concealing a lost edit.
// The real component, React event handlers and deferred API responses still run.
const scheduledDraftScenario = String.raw`
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const fromReactDOM = createRequire(require.resolve("react-dom"));
const scheduler = fromReactDOM("scheduler/unstable_mock");
require.cache[fromReactDOM.resolve("scheduler")] = { exports: scheduler };
require("./dom-setup");
globalThis.IS_REACT_ACT_ENVIRONMENT = false;
const React = require("react");
const { createRoot } = require("react-dom/client");
const { fireEvent, getByLabelText, getByRole, queryByRole, queryByLabelText } = require("@testing-library/dom");
const { ManualEditor } = require("./manual-editor");
const ordering = process.argv[1];
assert.ok(["before-passive", "after-passive"].includes(ordering));
const project = "018f6b6e-7c3a-7000-8000-000000000001";
const id = "018f6b6e-7c3a-7000-8000-000000000002";
const clip = "018f6b6e-7c3a-7000-8000-000000000003";
const other = "018f6b6e-7c3a-7000-8000-000000000004";
const names = ["Trim start (timeline seconds)", "Trim end (timeline seconds)", "Split at (timeline seconds)"];
const fixture = () => ({ stateSha256: "a".repeat(64), timeline: {
  id, projectId: project, composition: { width: 640, height: 360, durationUs: "2000000", frameRate: { numerator: "30", denominator: "1" } },
  tracks: [{ id, clips: [{ id: clip, sourceId: id, inPoint: "0", outPoint: "2000000", timelineStartUs: "0" }] }]
} });
const input = index => getByLabelText(document.body, names[index]);
const values = () => names.map((_, i) => input(i).value);
const disabled = () => names.map((_, i) => input(i).disabled);
const timeline = [];
function flush(phase, paint = false) {
  if (paint) scheduler.unstable_flushUntilNextPaint();
  else scheduler.unstable_flushAllWithoutAsserting();
  scheduler.unstable_clearLog();
  timeline.push({ phase, values: names.map(n => queryByLabelText(document.body, n)?.value ?? null) });
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
const reads = [];
const unexpected = async () => { throw Error("Unexpected mutation in a read/coordinate regression"); };
const api = { read: (_project, timelineId, signal) => new Promise(resolve => reads.push({ timelineId, signal, resolve })),
  create: unexpected, edit: unexpected, render: unexpected, job: unexpected, cancel: unexpected, download: unexpected };
const host = document.createElement("div"); document.body.append(host);
const root = createRoot(host);
const render = timelineId => root.render(React.createElement(ManualEditor, {
  projectId: project, initialTimelineId: timelineId, api, stream: { subscribe: () => () => {} }
}));
const reload = async () => { fireEvent.click(getByRole(document.body, "button", { name: "Reload saved timeline" })); await tick(); flush("pending-read"); assert.deepEqual(disabled(), [true, true, true]); };
const respond = async (index, result, phase, paint = false) => {
  assert.ok(reads[index]); reads[index].resolve(result); await tick(); flush(phase, paint);
  if (!paint) { await tick(); flush(phase + "-settled"); }
};
(async () => {
  render(id); await tick(); flush("mount"); assert.equal(reads.length, 1);
  await respond(0, { ok: true, data: fixture() }, "first-paint", true);
  const firstPaint = values();
  if (ordering === "after-passive") flush("control-initialization");
  assert.deepEqual(disabled(), [false, false, false]);
  fireEvent.change(input(1), { target: { value: "1.6" } });
  fireEvent.change(input(0), { target: { value: "0.3" } });
  fireEvent.change(input(2), { target: { value: "0.7" } });
  await tick(); flush("typed-draft", true);
  await reload(); assert.equal(reads.length, 2);
  const unchanged = fixture(); unchanged.stateSha256 = "b".repeat(64);
  await respond(1, { ok: true, data: unchanged }, "unchanged-response");
  assert.deepEqual(disabled(), [false, false, false]);
  assert.equal(input(1).value, "1.6");
  assert.deepEqual(values(), ["0.3", "1.6", "0.7"]);
  if (ordering === "before-passive") assert.deepEqual(firstPaint, ["0", "2", "1"]);

  await reload();
  const changed = fixture(); changed.stateSha256 = "c".repeat(64);
  Object.assign(changed.timeline.tracks[0].clips[0], { inPoint: "200000", outPoint: "1600000", timelineStartUs: "100000" });
  await respond(2, { ok: true, data: changed }, "changed-clip", ordering === "before-passive");
  assert.deepEqual(values(), ["0.1", "1.5", "0.8"]);

  await reload(); assert.equal(reads.length, 4);
  render(other); await tick(); flush("superseding-navigation");
  assert.equal(reads.length, 5); assert.equal(reads[3].signal.aborted, true);
  const fresh = fixture(); fresh.timeline.id = other; fresh.stateSha256 = "d".repeat(64);
  fresh.timeline.tracks[0].clips[0].id = other;
  await respond(4, { ok: true, data: fresh }, "fresh-timeline", ordering === "before-passive");
  assert.deepEqual(values(), ["0", "2", "1"]);
  await respond(3, { ok: false, status: 403, message: "Access denied." }, "stale-denial");
  assert.equal(getByRole(document.body, "region", { name: "Timeline" }).getAttribute("data-timeline-id"), other);
  assert.equal(queryByRole(document.body, "alert"), null);

  await reload(); await respond(5, { ok: false, status: 403, message: "Access denied." }, "active-denial");
  assert.equal(queryByRole(document.body, "region", { name: "Timeline" }), null);
  assert.equal(queryByLabelText(document.body, names[1]), null);
  render(id); await tick(); flush("pending-unmount"); assert.equal(reads.length, 7);
  root.unmount(); flush("unmount"); assert.equal(reads[6].signal.aborted, true);
  await respond(6, { ok: true, data: fixture() }, "late-after-unmount");
  assert.equal(host.childNodes.length, 0);
  console.log(JSON.stringify({ status: "PASS", ordering, firstPaint, reads: reads.length, timeline }));
})().catch(error => { console.error(error.stack); console.error(JSON.stringify({ ordering, timeline })); process.exitCode = 1; });
`;

test("first interactive paint and deferred reads preserve user drafts under either effect ordering", async (t) => {
  for (const ordering of ["before-passive", "after-passive"]) {
    await t.test(ordering, () => {
      const output = execFileSync(process.execPath, ["-e", scheduledDraftScenario, ordering], {
        cwd: __dirname,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1_048_576,
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot ?? "",
          TEMP: process.env.TEMP ?? "",
          TMP: process.env.TMP ?? "",
        },
      });
      const result = JSON.parse(output);
      assert.equal(result.status, "PASS");
      assert.equal(result.ordering, ordering);
      assert.equal(result.reads, 7);
    });
  }
});
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
test("a metadata-only reload must not overwrite draft trim and split coordinates", async () => {
  cleanup();
  render(<ManualEditor projectId={PROJECT} initialTimelineId={ID} api={api()} stream={stream} />);
  await screen.findByRole("region", { name: "Timeline" });
  fireEvent.change(screen.getByLabelText("Trim end (timeline seconds)"), {
    target: { value: "1.6" },
  });
  fireEvent.change(screen.getByLabelText("Split at (timeline seconds)"), {
    target: { value: "0.7" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Reload saved timeline" }));
  await waitFor(() =>
    assert.equal(
      (screen.getByRole("button", { name: "Reload saved timeline" }) as HTMLButtonElement).disabled,
      false,
    ),
  );
  assert.equal(
    (screen.getByLabelText("Trim end (timeline seconds)") as HTMLInputElement).value,
    "1.6",
  );
  assert.equal(
    (screen.getByLabelText("Split at (timeline seconds)") as HTMLInputElement).value,
    "0.7",
  );
  cleanup();
});
test("time entry is disabled during a pending response and draft coordinates survive an unchanged clip", async () => {
  cleanup();
  const client = api();
  let reads = 0,
    resume: ((value: Awaited<ReturnType<EditorApi["read"]>>) => void) | undefined;
  client.read = async () =>
    ++reads === 1
      ? { ok: true, data: fixture() }
      : new Promise((resolve) => {
          resume = resolve;
        });
  render(<ManualEditor projectId={PROJECT} initialTimelineId={ID} api={client} stream={stream} />);
  await screen.findByRole("region", { name: "Timeline" });
  fireEvent.change(screen.getByLabelText("Trim end (timeline seconds)"), {
    target: { value: "1.6" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Reload saved timeline" }));
  for (const name of [
    "Trim start (timeline seconds)",
    "Trim end (timeline seconds)",
    "Split at (timeline seconds)",
  ])
    assert.equal((screen.getByLabelText(name) as HTMLInputElement).disabled, true);
  assert.ok(resume);
  resume({ ok: true, data: fixture() });
  await waitFor(() =>
    assert.equal(
      (screen.getByLabelText("Trim end (timeline seconds)") as HTMLInputElement).disabled,
      false,
    ),
  );
  assert.equal(
    (screen.getByLabelText("Trim end (timeline seconds)") as HTMLInputElement).value,
    "1.6",
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

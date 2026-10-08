import "./dom-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { LibraryItem, MediaLibraryApi, MediaPreview } from "../media-library-contract";
import type { JobEventStream } from "../job-contract";
import {
  formatDuration,
  libraryStatus,
  MediaCard,
  MediaLibrary,
  spriteFrame,
} from "./media-library";

const ITEM: LibraryItem = {
  id: "media",
  displayFilename: "clip.mp4",
  kind: "video",
  duration: "65000000",
  inspectionStatus: "completed",
  validationStatus: "validated",
  rejectionCode: null,
  rejectionMessage: null,
  inspectionError: null,
  createdAt: "100",
  previews: { proxy: true, poster: true, sprite: true },
};
const PREVIEW: MediaPreview = {
  expiresInSeconds: 900,
  proxy: { available: true, url: "https://private.test/proxy.mp4" },
  poster: { available: true, url: "https://private.test/poster.jpg" },
  sprite: {
    available: true,
    url: "https://private.test/sprite.jpg",
    layout: {
      tileWidth: 160,
      tileHeight: 90,
      columns: 3,
      rows: 2,
      timestampsUs: ["1", "2", "3", "4"],
    },
  },
};
const stream: JobEventStream = { subscribe: () => () => {} };
function api(items: readonly LibraryItem[] = [ITEM], preview = PREVIEW): MediaLibraryApi {
  return {
    listMedia: async () => ({ ok: true, data: items }),
    getMediaPreview: async () => ({ ok: true, data: preview }),
  };
}

test("duration uses integer microseconds, including values beyond Number's safe range", () => {
  assert.equal(formatDuration("2000000"), "0:02");
  assert.equal(formatDuration("65000000"), "1:05");
  assert.equal(formatDuration("9007199254740993000000"), "150119987579016:33");
  assert.equal(formatDuration(null), "Duration unavailable");
  assert.equal(formatDuration("-1"), "Duration unavailable");
});

test("empty library and accessible refresh action", async () => {
  cleanup();
  render(<MediaLibrary projectId="project" api={api([])} stream={stream} />);
  await screen.findByText("No media yet. Upload a video to get started.");
  assert.ok(screen.getByRole("region", { name: "Media Library" }));
  assert.ok(screen.getByRole("button", { name: "Refresh library" }));
  cleanup();
});

test("processing, validation pending, missing derivatives, and safe failed reasons never request preview objects", async () => {
  cleanup();
  let calls = 0;
  const service = api();
  service.getMediaPreview = async () => {
    calls++;
    return { ok: true, data: PREVIEW };
  };
  for (const item of [
    { ...ITEM, inspectionStatus: "pending" as const },
    { ...ITEM, validationStatus: "pending" as const },
    { ...ITEM, previews: { proxy: true, poster: false, sprite: true } },
    {
      ...ITEM,
      validationStatus: "rejected" as const,
      rejectionMessage: "The file is not recognized media.",
    },
    { ...ITEM, inspectionStatus: "failed" as const, inspectionError: "timeout" },
  ]) {
    render(<MediaCard projectId="project" item={item} api={service} />);
    assert.equal(
      (screen.getByRole("button", { name: "Play proxy for clip.mp4" }) as HTMLButtonElement)
        .disabled,
      true,
    );
    assert.ok(screen.getByText(libraryStatus(item), { exact: true }));
    if (item.validationStatus === "rejected")
      assert.ok(screen.getByText("The file is not recognized media."));
    if (item.inspectionStatus === "failed")
      assert.ok(screen.getByText("Inspection failed: timeout"));
    cleanup();
  }
  assert.equal(calls, 0);
});

test("ready thumbnail, duration, touch fallback, and first/middle/last hover cells", async () => {
  cleanup();
  render(<MediaCard projectId="project" item={ITEM} api={api()} />);
  await screen.findByAltText("Thumbnail for clip.mp4");
  assert.ok(screen.getByText("1:05"));
  assert.ok(screen.getByText("Ready"));
  const button = screen.getByRole("button", { name: "Play proxy for clip.mp4" });
  button.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;
  fireEvent.pointerMove(button, { pointerType: "touch", clientX: 50 });
  assert.equal(document.querySelector("[data-sprite-sample]"), null);
  for (const [x, expected, left, top] of [
    [0, 0, "0%", "0%"],
    [50, 2, "-200%", "0%"],
    [100, 3, "0%", "-100%"],
  ] as const) {
    fireEvent.pointerMove(button, { pointerType: "mouse", clientX: x });
    const sheet = document.querySelector("[data-sprite-sample]") as HTMLImageElement;
    assert.equal(sheet.dataset.spriteSample, String(expected));
    assert.equal(sheet.style.left, left);
    assert.equal(sheet.style.top, top);
    assert.equal(sheet.src, PREVIEW.sprite.url);
  }
  fireEvent.pointerLeave(button);
  assert.equal(
    (document.querySelector('img[aria-hidden="true"]') as HTMLImageElement).style.display,
    "none",
  );
  cleanup();
});

test("single-cell sprite and clamped endpoints never select unused grid cells", () => {
  const one = { tileWidth: 160, tileHeight: 90, columns: 1, rows: 1, timestampsUs: ["1"] };
  for (const x of [-1, 0, 0.5, 1, 2])
    assert.deepEqual(spriteFrame(x, one), { index: 0, column: 0, row: 0 });
  assert.equal(spriteFrame(1, PREVIEW.sprite.layout!).index, 3);
});

test("player opens on keyboard button activation with fresh signed proxy and retries only once", async () => {
  cleanup();
  let calls = 0;
  const service = api();
  service.getMediaPreview = async () => {
    calls++;
    return {
      ok: true,
      data: {
        ...PREVIEW,
        proxy: { available: true, url: `https://private.test/proxy.mp4?generation=${calls}` },
      },
    };
  };
  render(<MediaCard projectId="project" item={ITEM} api={service} />);
  await screen.findByAltText("Thumbnail for clip.mp4");
  assert.equal(document.querySelector("video"), null);
  const button = screen.getByRole("button", { name: "Play proxy for clip.mp4" });
  button.focus();
  fireEvent.click(button);
  await waitFor(() =>
    assert.equal(
      (screen.getByLabelText("Proxy player for clip.mp4") as HTMLVideoElement).src,
      "https://private.test/proxy.mp4?generation=2",
    ),
  );
  let player = screen.getByLabelText("Proxy player for clip.mp4");
  assert.equal(player.getAttribute("preload"), "metadata");
  assert.ok(player.hasAttribute("controls"));
  fireEvent.error(player);
  await waitFor(() =>
    assert.equal(
      (screen.getByLabelText("Proxy player for clip.mp4") as HTMLVideoElement).src,
      "https://private.test/proxy.mp4?generation=3",
    ),
  );
  player = screen.getByLabelText("Proxy player for clip.mp4");
  fireEvent.error(player);
  await screen.findByRole("alert");
  assert.equal(calls, 3);
  fireEvent.click(screen.getByRole("button", { name: "Refresh previews" }));
  await waitFor(() => assert.equal(calls, 4));
  fireEvent.click(screen.getByRole("button", { name: "Close player" }));
  assert.equal(document.querySelector("video"), null);
  cleanup();
});

test("missing poster fallback retries once, then explicit recovery remains possible", async () => {
  cleanup();
  let calls = 0;
  const service = api();
  service.getMediaPreview = async () => {
    calls++;
    return { ok: true, data: PREVIEW };
  };
  render(<MediaCard projectId="project" item={ITEM} api={service} />);
  fireEvent.error(await screen.findByAltText("Thumbnail for clip.mp4"));
  await waitFor(() => assert.equal(calls, 2));
  fireEvent.error(await screen.findByAltText("Thumbnail for clip.mp4"));
  await screen.findByText("Thumbnail unavailable");
  assert.equal(calls, 2);
  cleanup();
});

test("idle pointer interaction refreshes expired preview URLs", async () => {
  cleanup();
  let calls = 0;
  const service = api();
  service.getMediaPreview = async () => {
    calls++;
    return { ok: true, data: { ...PREVIEW, expiresInSeconds: 1 } };
  };
  render(<MediaCard projectId="project" item={ITEM} api={service} />);
  await screen.findByAltText("Thumbnail for clip.mp4");
  fireEvent.pointerEnter(screen.getByRole("button", { name: "Play proxy for clip.mp4" }), {
    pointerType: "mouse",
  });
  await waitFor(() => assert.equal(calls, 2));
  cleanup();
});

test("upload and one Project stream reconcile persisted library states without polling", async () => {
  cleanup();
  let listener: Parameters<JobEventStream["subscribe"]>[1] | undefined;
  let subscriptions = 0,
    reads = 0;
  const service = api([]);
  service.listMedia = async () => ({ ok: true, data: ++reads === 1 ? [] : [ITEM] });
  const source: JobEventStream = {
    subscribe(_project, current) {
      subscriptions++;
      listener = current;
      return () => {};
    },
  };
  const view = render(<MediaLibrary projectId="project" api={service} stream={source} />);
  await screen.findByText("No media yet. Upload a video to get started.");
  view.rerender(
    <MediaLibrary projectId="project" refreshToken={1} api={service} stream={source} />,
  );
  await screen.findByText("Ready");
  assert.equal(subscriptions, 1);
  listener!.reconcile();
  await waitFor(() => assert.equal(reads, 3));
  cleanup();
});

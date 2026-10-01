import "./dom-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MediaDetails, ProjectApi, ProjectRecord } from "../project-contract";
import { MediaDetailsPanel } from "./media-details";
import { MediaWorkspace } from "./media-upload";
import { MAX_MEDIA_BYTES } from "./upload-policy";

const PROJECT = "018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f";
const MEDIA = "018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4f";
const HEADERS = {
  "Content-Type": "video/mp4",
  "x-amz-checksum-sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=",
  "If-None-Match": "*",
};

function project(role: ProjectRecord["role"]): ProjectRecord {
  return {
    id: PROJECT,
    name: "Launch",
    role,
    createdAt: "1700000000000",
    updatedAt: "1700000000000",
  };
}

function details(
  status: MediaDetails["inspectionStatus"],
  extra: Partial<MediaDetails> = {},
): MediaDetails {
  return {
    id: MEDIA,
    projectId: PROJECT,
    kind: "video",
    displayFilename: "clip.mp4",
    inspectionStatus: status,
    duration: null,
    container: null,
    videoCodec: null,
    audioCodec: null,
    width: null,
    height: null,
    displayWidth: null,
    displayHeight: null,
    rotation: null,
    frameRateNumerator: null,
    frameRateDenominator: null,
    frameRateMode: null,
    colorSpace: null,
    audioChannels: null,
    sampleRate: null,
    streams: null,
    inspectionError: null,
    ...extra,
  };
}

function workspaceApi(handlers: {
  begin?: ProjectApi["beginUpload"];
  complete?: ProjectApi["completeUpload"];
  details?: ProjectApi["getMediaDetails"];
}): ProjectApi {
  return {
    listProjects: async () => ({ ok: true, data: [] }),
    createProject: async () => ({ ok: false, status: 500, message: "not used" }),
    renameProject: async () => ({ ok: false, status: 500, message: "not used" }),
    deleteProject: async () => ({ ok: false, status: 500, message: "not used" }),
    beginUpload: handlers.begin ?? (async () => ({ ok: false, status: 500, message: "not used" })),
    completeUpload:
      handlers.complete ?? (async () => ({ ok: false, status: 500, message: "not used" })),
    getMediaDetails: handlers.details ?? (async () => ({ ok: true, data: details("pending") })),
  };
}

function video(name: string, type: string, contents: BlobPart = "abc"): File {
  return new File([contents], name, { type });
}

test("a dropped file and a keyboard-selected file are accepted", async () => {
  cleanup();
  let uploads = 0;
  render(
    <MediaWorkspace
      project={project("owner")}
      api={workspaceApi({
        begin: async () => {
          uploads += 1;
          return { ok: false, status: 401, message: "Sign in is required." };
        },
      })}
      hashFile={async () => "ab".repeat(32)}
    />,
  );
  const zone = screen.getByText("Drop a video here").parentElement;
  if (zone === null) {
    throw new Error("drop zone is missing");
  }
  const dropped = video("drop.mp4", "video/mp4");
  const dropEvent = new Event("drop", { bubbles: true });
  Object.defineProperty(dropEvent, "dataTransfer", { value: { files: [dropped] } });
  fireEvent(zone, dropEvent);
  await screen.findByRole("alert");
  const input = screen.getByLabelText("Choose a video");
  assert.equal(input.getAttribute("type"), "file");
  fireEvent.change(input, { target: { files: [video("keys.mp4", "video/mp4")] } });
  await waitFor(() => assert.equal(uploads, 2));
  cleanup();
});

test("unsupported, empty, oversized, and invalid names are not uploaded", async () => {
  cleanup();
  let begins = 0;
  const view = render(
    <MediaWorkspace
      project={project("editor")}
      api={workspaceApi({
        begin: async () => {
          begins += 1;
          return { ok: false, status: 500, message: "not used" };
        },
      })}
      hashFile={async () => "ab".repeat(32)}
    />,
  );
  const input = screen.getByLabelText("Choose a video");
  fireEvent.change(input, { target: { files: [video("notes.txt", "text/plain")] } });
  await screen.findByText(/Media MIME type must be/);
  const empty = video("empty.mp4", "video/mp4", new ArrayBuffer(0));
  fireEvent.change(input, { target: { files: [empty] } });
  await screen.findByText(/file is empty/);
  const huge = video("huge.mp4", "video/mp4");
  Object.defineProperty(huge, "size", { value: MAX_MEDIA_BYTES + 1 });
  fireEvent.change(input, { target: { files: [huge] } });
  await waitFor(() => assert.match(screen.getByRole("alert").textContent ?? "", /4 GiB/));
  fireEvent.change(input, { target: { files: [video("bad\nname.mp4", "video/mp4")] } });
  await screen.findByText(/control characters/);
  assert.equal(begins, 0);
  view.unmount();
  cleanup();
});

test("hashing can be cancelled and reports progress", async () => {
  cleanup();
  let progress = false;
  render(
    <MediaWorkspace
      project={project("owner")}
      api={workspaceApi({})}
      hashFile={(_file, options) =>
        new Promise((_resolve, reject) => {
          options?.onProgress?.(2, 4);
          progress = true;
          options?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The hash was cancelled.", "AbortError"));
          });
        })
      }
    />,
  );
  fireEvent.change(screen.getByLabelText("Choose a video"), {
    target: { files: [video("clip.mp4", "video/mp4")] },
  });
  const bar = await screen.findByRole("progressbar");
  assert.equal(bar.getAttribute("value"), "2");
  assert.equal(progress, true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await screen.findByText(/was cancelled/);
  cleanup();
});

test("a successful upload sends the signed headers and shows pending details", async () => {
  cleanup();
  let seen: Record<string, string> | undefined;
  let progress = 0;
  render(
    <MediaWorkspace
      project={project("owner")}
      api={workspaceApi({
        begin: async () => ({
          ok: true,
          data: {
            uploadUrl: "http://storage.test/put",
            storageKey: "projects/p/media/sha256/ab",
            expiresAt: "1700000000000",
            requiredHeaders: HEADERS,
          },
        }),
        complete: async () => ({
          ok: true,
          data: {
            id: MEDIA,
            projectId: PROJECT,
            kind: "video",
            displayFilename: "clip.mp4",
            mimeType: "video/mp4",
            byteSize: "3",
            createdAt: "1700000000000",
          },
        }),
        details: async () => ({
          ok: true,
          data: details("pending", { displayFilename: "clip.mp4" }),
        }),
      })}
      hashFile={async () => "ab".repeat(32)}
      putObject={async (request) => {
        seen = { ...request.headers };
        request.onProgress?.(1, 3);
        progress = 1;
        request.onProgress?.(3, 3);
        return { ok: true, status: 200 };
      }}
    />,
  );
  fireEvent.change(screen.getByLabelText("Choose a video"), {
    target: { files: [video("clip.mp4", "video/mp4")] },
  });
  await screen.findByText("pending");
  assert.equal(screen.getByText("Container").nextElementSibling?.textContent, "Unavailable");
  assert.equal(screen.queryByText("0"), null);
  assert.deepEqual(seen, HEADERS);
  assert.equal(progress, 1);
  assert.ok(screen.getByText(/Upload complete/));
  cleanup();
});

test("a failed PUT and a failed complete stay in an error state", async () => {
  cleanup();
  let completes = 0;
  const api = workspaceApi({
    begin: async () => ({
      ok: true,
      data: {
        uploadUrl: "http://storage.test/put",
        storageKey: "key",
        expiresAt: "1",
        requiredHeaders: HEADERS,
      },
    }),
    complete: async () => {
      completes += 1;
      return {
        ok: false,
        status: 409,
        message: "The uploaded object does not match the declared upload.",
      };
    },
  });
  const { rerender } = render(
    <MediaWorkspace
      project={project("owner")}
      api={api}
      hashFile={async () => "ab".repeat(32)}
      putObject={async () => ({ ok: false, status: 403 })}
    />,
  );
  fireEvent.change(screen.getByLabelText("Choose a video"), {
    target: { files: [video("clip.mp4", "video/mp4")] },
  });
  await screen.findByText(/signature was rejected/);
  assert.equal(completes, 0);
  rerender(
    <MediaWorkspace
      project={project("owner")}
      api={api}
      hashFile={async () => "ab".repeat(32)}
      putObject={async () => ({ ok: true, status: 200 })}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Choose another file" }));
  fireEvent.change(screen.getByLabelText("Choose a video"), {
    target: { files: [video("clip.mp4", "video/mp4")] },
  });
  await screen.findByText(/does not match/);
  assert.equal(screen.queryByText(/Upload complete/), null);
  cleanup();
});

test("a conditional PUT is verified by complete and is not treated as success by itself", async () => {
  cleanup();
  let completes = 0;
  render(
    <MediaWorkspace
      project={project("owner")}
      api={workspaceApi({
        begin: async () => ({
          ok: true,
          data: {
            uploadUrl: "http://storage.test/put",
            storageKey: "key",
            expiresAt: "1",
            requiredHeaders: HEADERS,
          },
        }),
        complete: async () => {
          completes += 1;
          return {
            ok: false,
            status: 409,
            message: "The uploaded object does not match the declared upload.",
          };
        },
      })}
      hashFile={async () => "ab".repeat(32)}
      putObject={async () => ({ ok: false, status: 412 })}
    />,
  );
  fireEvent.change(screen.getByLabelText("Choose a video"), {
    target: { files: [video("clip.mp4", "video/mp4")] },
  });
  await screen.findByText(/does not match/);
  assert.equal(completes, 1);
  assert.equal(screen.queryByText(/Upload complete/), null);
  cleanup();
});

test("completed and failed inspection details render without invented zeros", () => {
  const { rerender } = render(
    <MediaDetailsPanel
      refreshing={false}
      onRefresh={() => undefined}
      details={details("completed", {
        displayFilename: "normal.mp4",
        container: "MP4",
        videoCodec: "h264",
        audioCodec: "aac",
        width: 320,
        height: 240,
        displayWidth: 320,
        displayHeight: 240,
        rotation: null,
        frameRateNumerator: "25",
        frameRateDenominator: "1",
        frameRateMode: "constant",
        duration: "1000000",
        colorSpace: null,
        audioChannels: 1,
        sampleRate: 48000,
        streams: [
          {
            codecType: "video",
            codecName: "h264",
            width: 320,
            height: 240,
            sampleRate: null,
            channels: null,
          },
          {
            codecType: "audio",
            codecName: "aac",
            width: null,
            height: null,
            sampleRate: 48000,
            channels: 1,
          },
        ],
      })}
    />,
  );
  assert.equal(screen.getByText("MP4").textContent, "MP4");
  assert.equal(screen.getByText("25/1").textContent, "25/1");
  assert.equal(screen.getByText("1000000").textContent, "1000000");
  assert.ok(screen.getAllByText("320×240").length >= 1);
  assert.ok(screen.getAllByText(/h264/).length >= 1);
  rerender(
    <MediaDetailsPanel
      refreshing={false}
      onRefresh={() => undefined}
      details={details("failed", { inspectionError: "invalid_json" })}
    />,
  );
  assert.ok(screen.getByRole("alert").textContent?.includes("invalid_json"));
  assert.equal(screen.queryByText("0"), null);
});

test("a viewer cannot upload and a long filename wraps", async () => {
  cleanup();
  const { rerender } = render(
    <MediaWorkspace project={project("viewer")} api={workspaceApi({})} />,
  );
  assert.equal(screen.queryByLabelText("Choose a video"), null);
  const longName = `${"字".repeat(180)}.mp4`;
  rerender(
    <MediaWorkspace
      project={project("owner")}
      api={workspaceApi({})}
      hashFile={() => new Promise(() => undefined)}
    />,
  );
  fireEvent.change(screen.getByLabelText("Choose a video"), {
    target: { files: [video(longName, "video/mp4")] },
  });
  const shown = await screen.findByText(longName, { exact: false });
  assert.ok(shown.className.includes("overflow-anywhere"));
  assert.ok(screen.getByText("Drop a video here").parentElement?.className.includes("min-w-0"));
  cleanup();
});

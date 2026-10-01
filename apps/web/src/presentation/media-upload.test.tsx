import "./dom-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const ID_A = "018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4f";
const ID_B = "018f6b6e-7c3a-7b2d-8d3e-9c0b1a2d3e4f";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function recorded(id: string, name: string) {
  return {
    id,
    projectId: PROJECT,
    kind: "video" as const,
    displayFilename: name,
    mimeType: "video/mp4",
    byteSize: "3",
    createdAt: "1700000000000",
  };
}

test("a delayed refresh for the previous asset cannot replace the new asset", async () => {
  cleanup();
  const reads = [] as Array<
    ReturnType<typeof deferred<Awaited<ReturnType<ProjectApi["getMediaDetails"]>>>>
  >;
  let completed = 0;
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
          completed += 1;
          const id = completed === 1 ? ID_A : ID_B;
          const name = completed === 1 ? "alpha.mp4" : "beta.mp4";
          return { ok: true, data: recorded(id, name) };
        },
        details: () => {
          const pending = deferred<Awaited<ReturnType<ProjectApi["getMediaDetails"]>>>();
          reads.push(pending);
          return pending.promise;
        },
      })}
      hashFile={async () => "ab".repeat(32)}
      putObject={async () => ({ ok: true, status: 200 })}
    />,
  );
  fireEvent.change(screen.getByLabelText("Choose a video"), {
    target: { files: [video("alpha.mp4", "video/mp4")] },
  });
  await waitFor(() => assert.equal(reads.length, 1));
  reads[0]!.resolve({
    ok: true,
    data: details("pending", { id: ID_A, displayFilename: "alpha.mp4" }),
  });
  await waitFor(() =>
    assert.equal(document.querySelector("[data-media-id]")?.getAttribute("data-media-id"), ID_A),
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh details" }));
  await waitFor(() => assert.equal(reads.length, 2));
  fireEvent.change(screen.getByLabelText("Choose a video"), {
    target: { files: [video("beta.mp4", "video/mp4")] },
  });
  await waitFor(() => assert.equal(reads.length, 3));
  reads[2]!.resolve({
    ok: true,
    data: details("completed", {
      id: ID_B,
      displayFilename: "beta.mp4",
      videoCodec: "h264",
    }),
  });
  await waitFor(() =>
    assert.equal(document.querySelector("[data-media-id]")?.getAttribute("data-media-id"), ID_B),
  );
  reads[1]!.resolve({
    ok: true,
    data: details("completed", {
      id: ID_A,
      displayFilename: "alpha.mp4",
      videoCodec: "vp9",
    }),
  });
  await act(async () => {
    await Promise.resolve();
  });
  assert.equal(document.querySelector("[data-media-id]")?.getAttribute("data-media-id"), ID_B);
  assert.ok(screen.getAllByText(/beta\.mp4/).length >= 1);
  assert.equal(screen.queryAllByText(/alpha\.mp4/).length, 0);
  assert.equal(screen.queryAllByText("vp9").length, 0);
  assert.ok(screen.getAllByText("h264").length >= 1);
  cleanup();
});

test("an older pending response cannot revert a completed inspection", async () => {
  cleanup();
  const reads = [] as Array<
    ReturnType<typeof deferred<Awaited<ReturnType<ProjectApi["getMediaDetails"]>>>>
  >;
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
        complete: async () => ({ ok: true, data: recorded(ID_A, "clip.mp4") }),
        details: () => {
          const pending = deferred<Awaited<ReturnType<ProjectApi["getMediaDetails"]>>>();
          reads.push(pending);
          return pending.promise;
        },
      })}
      hashFile={async () => "ab".repeat(32)}
      putObject={async () => ({ ok: true, status: 200 })}
    />,
  );
  fireEvent.change(screen.getByLabelText("Choose a video"), {
    target: { files: [video("clip.mp4", "video/mp4")] },
  });
  await waitFor(() => assert.equal(reads.length, 1));
  reads[0]!.resolve({
    ok: true,
    data: details("pending", { id: ID_A, displayFilename: "clip.mp4" }),
  });
  await screen.findByText("pending");
  fireEvent.click(screen.getByRole("button", { name: "Refresh details" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh details" }));
  await waitFor(() => assert.equal(reads.length, 3));
  reads[2]!.resolve({
    ok: true,
    data: details("completed", { id: ID_A, displayFilename: "clip.mp4", videoCodec: "h264" }),
  });
  await screen.findByText("h264");
  reads[1]!.resolve({
    ok: true,
    data: details("pending", { id: ID_A, displayFilename: "clip.mp4" }),
  });
  await act(async () => {
    await Promise.resolve();
  });
  assert.equal(screen.getByText("completed").textContent, "completed");
  assert.ok(screen.getAllByText("h264").length >= 1);
  assert.equal(screen.queryByText("pending"), null);
  cleanup();
});

test("a refresh body for a different asset does not replace the displayed asset", async () => {
  cleanup();
  const reads = [] as Array<
    ReturnType<typeof deferred<Awaited<ReturnType<ProjectApi["getMediaDetails"]>>>>
  >;
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
        complete: async () => ({ ok: true, data: recorded(ID_B, "beta.mp4") }),
        details: () => {
          const pending = deferred<Awaited<ReturnType<ProjectApi["getMediaDetails"]>>>();
          reads.push(pending);
          return pending.promise;
        },
      })}
      hashFile={async () => "ab".repeat(32)}
      putObject={async () => ({ ok: true, status: 200 })}
    />,
  );
  fireEvent.change(screen.getByLabelText("Choose a video"), {
    target: { files: [video("beta.mp4", "video/mp4")] },
  });
  await waitFor(() => assert.equal(reads.length, 1));
  reads[0]!.resolve({
    ok: true,
    data: details("completed", { id: ID_B, displayFilename: "beta.mp4", videoCodec: "h264" }),
  });
  await screen.findByText("h264");
  fireEvent.click(screen.getByRole("button", { name: "Refresh details" }));
  await waitFor(() => assert.equal(reads.length, 2));
  reads[1]!.resolve({
    ok: true,
    data: details("completed", { id: ID_A, displayFilename: "alpha.mp4", videoCodec: "vp9" }),
  });
  await screen.findByText("Details could not be refreshed.");
  assert.equal(document.querySelector("[data-media-id]")?.getAttribute("data-media-id"), ID_B);
  assert.ok(screen.getAllByText(/beta\.mp4/).length >= 1);
  assert.equal(screen.queryAllByText(/alpha\.mp4/).length, 0);
  assert.equal(screen.queryAllByText("vp9").length, 0);
  assert.ok(screen.getAllByText("h264").length >= 1);
  assert.equal(
    screen.getByRole("button", { name: "Refresh details" }).getAttribute("aria-busy"),
    "false",
  );
  assert.equal(reads.length, 2);
  cleanup();
});

test("a refresh body for the same asset updates the displayed metadata", async () => {
  cleanup();
  const reads = [] as Array<
    ReturnType<typeof deferred<Awaited<ReturnType<ProjectApi["getMediaDetails"]>>>>
  >;
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
        complete: async () => ({ ok: true, data: recorded(ID_B, "beta.mp4") }),
        details: () => {
          const pending = deferred<Awaited<ReturnType<ProjectApi["getMediaDetails"]>>>();
          reads.push(pending);
          return pending.promise;
        },
      })}
      hashFile={async () => "ab".repeat(32)}
      putObject={async () => ({ ok: true, status: 200 })}
    />,
  );
  fireEvent.change(screen.getByLabelText("Choose a video"), {
    target: { files: [video("beta.mp4", "video/mp4")] },
  });
  await waitFor(() => assert.equal(reads.length, 1));
  reads[0]!.resolve({
    ok: true,
    data: details("pending", { id: ID_B, displayFilename: "beta.mp4" }),
  });
  await screen.findByText("pending");
  fireEvent.click(screen.getByRole("button", { name: "Refresh details" }));
  await waitFor(() => assert.equal(reads.length, 2));
  reads[1]!.resolve({
    ok: true,
    data: details("completed", {
      id: ID_B,
      displayFilename: "beta.mp4",
      videoCodec: "h264",
      container: "MP4",
    }),
  });
  await screen.findByText("h264");
  assert.equal(document.querySelector("[data-media-id]")?.getAttribute("data-media-id"), ID_B);
  assert.ok(screen.getByText("MP4"));
  assert.equal(screen.queryByText("Details could not be refreshed."), null);
  assert.equal(
    screen.getByRole("button", { name: "Refresh details" }).getAttribute("aria-busy"),
    "false",
  );
  cleanup();
});

test("a scheduled poll that returns another asset does not replace the pending asset", async () => {
  cleanup();
  let reads = 0;
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
        complete: async () => ({ ok: true, data: recorded(ID_B, "beta.mp4") }),
        details: async () => {
          reads += 1;
          if (reads === 1) {
            return {
              ok: true,
              data: details("pending", { id: ID_B, displayFilename: "beta.mp4" }),
            };
          }
          return {
            ok: true,
            data: details("completed", {
              id: ID_A,
              displayFilename: "alpha.mp4",
              videoCodec: "vp9",
            }),
          };
        },
      })}
      hashFile={async () => "ab".repeat(32)}
      putObject={async () => ({ ok: true, status: 200 })}
    />,
  );
  fireEvent.change(screen.getByLabelText("Choose a video"), {
    target: { files: [video("beta.mp4", "video/mp4")] },
  });
  await screen.findByText("pending");
  await waitFor(
    () => {
      assert.ok(screen.getByText("Details could not be refreshed."));
    },
    { timeout: 4000 },
  );
  assert.equal(document.querySelector("[data-media-id]")?.getAttribute("data-media-id"), ID_B);
  assert.equal(screen.queryAllByText(/alpha\.mp4/).length, 0);
  assert.equal(screen.queryAllByText("vp9").length, 0);
  assert.ok(screen.getByText("pending"));
  assert.equal(reads, 2);
  assert.equal(
    screen.getByRole("button", { name: "Refresh details" }).getAttribute("aria-busy"),
    "false",
  );
  cleanup();
});

test("a refresh that resolves after unmount does not update the page", async () => {
  cleanup();
  const warnings: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    warnings.push(args.map((item) => String(item)).join(" "));
  };
  try {
    const reads = [] as Array<
      ReturnType<typeof deferred<Awaited<ReturnType<ProjectApi["getMediaDetails"]>>>>
    >;
    const view = render(
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
          complete: async () => ({ ok: true, data: recorded(ID_B, "beta.mp4") }),
          details: () => {
            const pending = deferred<Awaited<ReturnType<ProjectApi["getMediaDetails"]>>>();
            reads.push(pending);
            return pending.promise;
          },
        })}
        hashFile={async () => "ab".repeat(32)}
        putObject={async () => ({ ok: true, status: 200 })}
      />,
    );
    fireEvent.change(screen.getByLabelText("Choose a video"), {
      target: { files: [video("beta.mp4", "video/mp4")] },
    });
    await waitFor(() => assert.equal(reads.length, 1));
    reads[0]!.resolve({
      ok: true,
      data: details("completed", { id: ID_B, displayFilename: "beta.mp4", videoCodec: "h264" }),
    });
    await screen.findByText("h264");
    fireEvent.click(screen.getByRole("button", { name: "Refresh details" }));
    await waitFor(() => assert.equal(reads.length, 2));
    view.unmount();
    reads[1]!.resolve({
      ok: true,
      data: details("completed", { id: ID_A, displayFilename: "alpha.mp4", videoCodec: "vp9" }),
    });
    await act(async () => {
      await Promise.resolve();
    });
    assert.equal(document.body.textContent?.includes("vp9"), false);
    assert.equal(document.body.textContent?.includes("alpha.mp4"), false);
    assert.equal(document.body.textContent?.includes("Details could not be refreshed."), false);
    assert.equal(
      warnings.some((warning) => warning.includes("unmounted")),
      false,
    );
  } finally {
    console.error = original;
    cleanup();
  }
});

test("a late hashing progress event cannot revive a cancelled upload", async () => {
  cleanup();
  let begins = 0;
  render(
    <MediaWorkspace
      project={project("owner")}
      api={workspaceApi({
        begin: async () => {
          begins += 1;
          return { ok: false, status: 401, message: "Sign in is required." };
        },
      })}
      hashFile={(file, options) => {
        if (!(file instanceof File) || file.name !== "late.mp4") {
          return Promise.resolve("cd".repeat(32));
        }
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            setTimeout(() => {
              options.onProgress?.(4, 4);
              reject(new DOMException("The hash was cancelled.", "AbortError"));
            }, 0);
          });
        });
      }}
    />,
  );
  fireEvent.change(screen.getByLabelText("Choose a video"), {
    target: { files: [video("late.mp4", "video/mp4")] },
  });
  await screen.findByText("Calculating SHA-256.");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await screen.findByText(/was cancelled/);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(screen.queryByText(/late\.mp4/), null);
  assert.equal(screen.queryByText("Calculating SHA-256."), null);
  assert.equal(begins, 0);
  fireEvent.change(screen.getByLabelText("Choose a video"), {
    target: { files: [video("next.mp4", "video/mp4")] },
  });
  await screen.findByText("Sign in is required.");
  assert.equal(begins, 1);
  assert.equal(screen.queryByText(/late\.mp4/), null);
  assert.equal(screen.queryByText("Calculating SHA-256."), null);
  assert.equal(
    screen.getByText("The file was not uploaded.").textContent,
    "The file was not uploaded.",
  );
  cleanup();
});

test("only one upload starts when two files are chosen in the same turn", async () => {
  cleanup();
  let hashes = 0;
  render(
    <MediaWorkspace
      project={project("owner")}
      api={workspaceApi({})}
      hashFile={() => {
        hashes += 1;
        return new Promise(() => undefined);
      }}
    />,
  );
  const input = screen.getByLabelText("Choose a video");
  fireEvent.change(input, { target: { files: [video("one.mp4", "video/mp4")] } });
  fireEvent.change(input, { target: { files: [video("two.mp4", "video/mp4")] } });
  assert.equal(hashes, 1);
  assert.ok(screen.getByText(/one\.mp4/));
  assert.equal(screen.queryByText(/two\.mp4/), null);
  cleanup();
});

test("late begin, complete, and details results do not update an unmounted page", async () => {
  cleanup();
  const warnings: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    warnings.push(args.map((item) => String(item)).join(" "));
  };
  try {
    const begin = deferred<Awaited<ReturnType<ProjectApi["beginUpload"]>>>();
    const complete = deferred<Awaited<ReturnType<ProjectApi["completeUpload"]>>>();
    const detailsRead = deferred<Awaited<ReturnType<ProjectApi["getMediaDetails"]>>>();
    const view = render(
      <MediaWorkspace
        project={project("owner")}
        api={workspaceApi({
          begin: () => begin.promise,
          complete: () => complete.promise,
          details: () => detailsRead.promise,
        })}
        hashFile={async () => "ab".repeat(32)}
        putObject={async () => ({ ok: true, status: 200 })}
      />,
    );
    fireEvent.change(screen.getByLabelText("Choose a video"), {
      target: { files: [video("clip.mp4", "video/mp4")] },
    });
    await screen.findByText("Requesting an upload URL.");
    view.unmount();
    begin.resolve({
      ok: true,
      data: {
        uploadUrl: "http://storage.test/put",
        storageKey: "key",
        expiresAt: "1",
        requiredHeaders: HEADERS,
      },
    });
    complete.resolve({ ok: true, data: recorded(ID_A, "clip.mp4") });
    detailsRead.resolve({
      ok: true,
      data: details("completed", { id: ID_A, videoCodec: "h264" }),
    });
    await act(async () => {
      await Promise.resolve();
    });
    assert.equal(document.body.textContent?.includes("h264"), false);
    assert.equal(document.body.textContent?.includes("Upload complete"), false);
    assert.equal(
      warnings.some((warning) => warning.includes("unmounted")),
      false,
    );

    const completeWait = deferred<Awaited<ReturnType<ProjectApi["completeUpload"]>>>();
    const completing = render(
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
          complete: () => completeWait.promise,
          details: async () => ({ ok: true, data: details("pending", { id: ID_A }) }),
        })}
        hashFile={async () => "ab".repeat(32)}
        putObject={async () => ({ ok: true, status: 200 })}
      />,
    );
    fireEvent.change(screen.getByLabelText("Choose a video"), {
      target: { files: [video("clip.mp4", "video/mp4")] },
    });
    await screen.findByText("Confirming the stored object.");
    completing.unmount();
    completeWait.resolve({ ok: true, data: recorded(ID_A, "clip.mp4") });
    await act(async () => {
      await Promise.resolve();
    });
    assert.equal(document.body.textContent?.includes("Upload complete"), false);

    const detailsWait = deferred<Awaited<ReturnType<ProjectApi["getMediaDetails"]>>>();
    const loading = render(
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
          complete: async () => ({ ok: true, data: recorded(ID_A, "clip.mp4") }),
          details: () => detailsWait.promise,
        })}
        hashFile={async () => "ab".repeat(32)}
        putObject={async () => ({ ok: true, status: 200 })}
      />,
    );
    fireEvent.change(screen.getByLabelText("Choose a video"), {
      target: { files: [video("clip.mp4", "video/mp4")] },
    });
    await screen.findByText("Confirming the stored object.");
    loading.unmount();
    detailsWait.resolve({
      ok: true,
      data: details("completed", { id: ID_A, videoCodec: "h264" }),
    });
    await act(async () => {
      await Promise.resolve();
    });
    assert.equal(document.body.textContent?.includes("h264"), false);
    assert.equal(
      warnings.some((warning) => warning.includes("unmounted")),
      false,
    );
  } finally {
    console.error = original;
    cleanup();
  }
});

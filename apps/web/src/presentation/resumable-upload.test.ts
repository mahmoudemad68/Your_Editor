import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  MultipartApi,
  MultipartState,
  MediaAssetRecord,
  UploadDeclaration,
} from "../project-contract";
import type { SavedUpload, UploadStateStore } from "./upload-state";
import { UploadProgress, missingParts } from "./upload-progress";
import { resumeMultipart, retryableStatus, retryDelay, abortableWait } from "./resumable-upload";
import type { SignedPutRequest, SignedPutResult } from "./signed-upload";
import type { TransferUpdate } from "./resumable-upload";
import { UploadRequestError } from "./multipart-api";
const SIZE = 16 * 1024 * 1024;
const declaration: UploadDeclaration = {
  filename: "resume.mp4",
  mimeType: "video/mp4",
  byteSize: SIZE * 4,
  sha256: "ab".repeat(32),
};
const asset = {
  id: "asset",
  projectId: "project",
  kind: "video",
  displayFilename: "resume.mp4",
  mimeType: "video/mp4",
  byteSize: String(declaration.byteSize),
  createdAt: "1",
} as MediaAssetRecord;
function harness(completed: number[] = []) {
  let saved: SavedUpload | null = null;
  let starts = 0,
    active = 0,
    maxActive = 0,
    complete = 0;
  const signed: number[] = [],
    puts: number[] = [];
  const state: MultipartState = {
    ...declaration,
    uploadSessionId: "session",
    partSize: SIZE,
    status: "active",
    expiresAt: "1000",
    mediaAssetId: null,
    parts: completed.map((partNumber) => ({
      partNumber,
      etag: `etag-${partNumber}`,
      byteSize: SIZE,
      checksum: null,
    })),
  };
  const store: UploadStateStore = {
    get: async () => saved,
    save: async (r) => {
      saved = r;
    },
    remove: async () => {
      saved = null;
    },
  };
  const api: MultipartApi = {
    start: async () => {
      starts++;
      return state;
    },
    state: async () => state,
    sign: async (_p, _id, n) => {
      signed.push(n);
      return { url: `https://storage.test/${n}`, requiredHeaders: {}, expiresAt: "1000" };
    },
    record: async (_p, _id, n, etag) => {
      state.parts.push({ partNumber: n, etag, byteSize: SIZE, checksum: null });
      return state;
    },
    complete: async () => {
      complete++;
      return asset;
    },
    abort: async () => {},
  };
  const file = new File([new Uint8Array(declaration.byteSize)], declaration.filename, {
    type: declaration.mimeType,
  });
  const options = {
    file,
    declaration,
    projectId: "project",
    scope: "owner:project",
    api,
    store,
    signal: new AbortController().signal,
    onUpdate: (_update: TransferUpdate) => {},
    put: async (request: SignedPutRequest): Promise<SignedPutResult> => {
      const n = Number(new URL(request.url).pathname.slice(1));
      puts.push(n);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      request.onProgress?.(request.body.size, request.body.size);
      active--;
      return { ok: true, status: 200, etag: `etag-${n}` };
    },
  };
  return {
    options,
    state,
    store,
    signed,
    puts,
    get saved() {
      return saved;
    },
    get starts() {
      return starts;
    },
    get complete() {
      return complete;
    },
    get maxActive() {
      return maxActive;
    },
  };
}
test("AC1 deterministic 1.5 GB and 1.5 GiB boundaries schedule only remaining parts around 50%", () => {
  const decimalSize = 1_500_000_000;
  const decimalDone = Array.from({ length: 45 }, (_, i) => ({ partNumber: i + 1 }));
  assert.deepEqual(
    missingParts(decimalSize, SIZE, decimalDone),
    Array.from({ length: 45 }, (_, i) => i + 46),
  );
  assert.ok(Math.abs((45 * SIZE) / decimalSize - 0.5) < 0.01);
  assert.equal(decimalSize - 89 * SIZE, 6_827_776);
  const total = 1.5 * 1024 ** 3;
  const completed = Array.from({ length: 48 }, (_, i) => ({ partNumber: i + 1 }));
  const missing = missingParts(total, SIZE, completed);
  assert.equal(total, 1610612736);
  assert.equal(completed.length * SIZE, total / 2);
  assert.deepEqual(
    missing,
    Array.from({ length: 48 }, (_, i) => i + 49),
  );
  assert.deepEqual(
    missingParts(SIZE * 4, SIZE, [{ partNumber: 1 }, { partNumber: 2 }, { partNumber: 4 }]),
    [3],
  );
  assert.equal(missingParts(4 * 1024 ** 3, SIZE, []).length, 256);
});
test("reload uses server parts despite stale local metadata, skips completed PUTs and caps concurrency", async () => {
  const h = harness([1, 2]);
  await h.store.save({
    ...declaration,
    scope: "owner:project",
    projectId: "project",
    uploadSessionId: "session",
    partSize: SIZE,
    lastModified: 0,
    updatedAt: 0,
  });
  const updates: number[] = [];
  h.options.onUpdate = (update) => {
    updates.push(update.loaded);
  };
  assert.equal((await resumeMultipart(h.options)).id, asset.id);
  assert.equal(h.starts, 0);
  assert.deepEqual(h.puts.sort(), [3, 4]);
  assert.equal(updates[0], SIZE * 2);
  assert.ok(h.maxActive <= 3);
  assert.equal(h.saved, null);
  assert.equal(h.complete, 1);
});
test("same filename and size with different content identity is rejected before signing", async () => {
  const h = harness();
  await h.store.save({
    ...declaration,
    sha256: "cd".repeat(32),
    scope: "owner:project",
    projectId: "project",
    uploadSessionId: "session",
    partSize: SIZE,
    lastModified: 0,
    updatedAt: 0,
  });
  await assert.rejects(() => resumeMultipart(h.options), /does not match/);
  assert.equal(h.signed.length, 0);
  assert.equal(h.complete, 0);
});
test("transient part failures/expired URL get bounded per-part retries; permanent failures do not", async () => {
  const h = harness([1, 2, 3]);
  let attempts = 0;
  h.options.put = async () => {
    attempts++;
    return attempts < 3 ? { ok: false, status: 503 } : { ok: true, status: 200, etag: "etag-4" };
  };
  await resumeMultipart({ ...h.options, wait: async () => {} });
  assert.equal(attempts, 3);
  assert.deepEqual(h.signed, [4, 4, 4]);
  const permanent = harness([1, 2, 3]);
  permanent.options.put = async () => ({ ok: false, status: 400 });
  await assert.rejects(
    () => resumeMultipart({ ...permanent.options, wait: async () => {} }),
    UploadRequestError,
  );
  assert.equal(permanent.signed.length, 1);
  assert.ok(permanent.saved);
  assert.equal(permanent.complete, 0);
  const bounded = harness([1, 2, 3]);
  bounded.options.put = async () => ({ ok: false, status: 0 });
  await assert.rejects(
    () => resumeMultipart({ ...bounded.options, wait: async () => {} }),
    UploadRequestError,
  );
  assert.equal(bounded.signed.length, 4);
  const expired = harness([1, 2, 3]);
  let expirations = 0;
  await resumeMultipart({
    ...expired.options,
    wait: async () => {},
    put: async () =>
      ++expirations === 1
        ? { ok: false, status: 403, expired: true }
        : { ok: true, status: 200, etag: "etag-4" },
  });
  assert.equal(expirations, 2);
});
test("lost ACK reconciles provider state and does not repeat the successful part", async () => {
  const h = harness([1, 2, 3]);
  let count = 0;
  await resumeMultipart({
    ...h.options,
    wait: async () => {},
    put: async () => {
      count++;
      h.state.parts.push({ partNumber: 4, etag: "provider-etag", byteSize: SIZE, checksum: null });
      return { ok: false, status: 0 };
    },
  });
  assert.equal(count, 1);
  assert.equal(h.complete, 1);
});
test("cancellation stops retry timers/new requests and preserves metadata", async () => {
  const h = harness([1, 2, 3]),
    controller = new AbortController();
  await assert.rejects(() =>
    resumeMultipart({
      ...h.options,
      signal: controller.signal,
      put: async () => ({ ok: false, status: 0 }),
      wait: async (_ms, signal) => {
        controller.abort();
        await abortableWait(10000, signal);
      },
    }),
  );
  assert.equal(h.signed.length, 1);
  assert.ok(h.saved);
  assert.equal(h.complete, 0);
  const waitController = new AbortController();
  const waiting = abortableWait(10000, waitController.signal);
  waitController.abort();
  await assert.rejects(() => waiting, { name: "AbortError" });
});
test("an invalid recovered part plan rejects without starting transfers or a live timer", async () => {
  const h = harness();
  h.state.partSize = 0;
  await assert.rejects(() => resumeMultipart(h.options));
  assert.equal(h.signed.length, 0);
  assert.equal(h.complete, 0);
});
test("progress restores durable bytes, does not double-count retries, and rate/ETA decay after pauses", () => {
  let now = 0;
  const progress = new UploadProgress(100, [{ partNumber: 1, byteSize: 50 }], () => now);
  assert.equal(progress.snapshot().loaded, 50);
  assert.equal(progress.snapshot().eta, null);
  now = 1000;
  progress.progress(2, 25);
  assert.equal(progress.snapshot().speed, 25);
  assert.equal(progress.snapshot().eta, 1);
  progress.pause();
  assert.equal(progress.snapshot().loaded, 50);
  assert.equal(progress.snapshot().durableLoaded, 50);
  progress.reset(2);
  assert.equal(progress.snapshot().loaded, 50);
  progress.progress(2, 50);
  progress.commit(2, 50);
  assert.equal(progress.snapshot().loaded, 100);
  assert.equal(progress.snapshot().percent, 99.9);
  assert.equal(progress.snapshot(true).percent, 100);
  now = 11000;
  progress.snapshot();
  now = 16000;
  assert.equal(progress.snapshot().speed, 0);
  assert.equal(progress.snapshot().eta, null);
  for (const status of [0, 408, 500, 502, 503, 504]) assert.equal(retryableStatus(status), true);
  for (const status of [400, 401, 403, 409, 404]) assert.equal(retryableStatus(status), false);
  assert.equal(
    retryDelay(0, () => 0),
    250,
  );
  assert.ok(retryDelay(10, () => 1) <= 8000);
});

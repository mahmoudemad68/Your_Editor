import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { hashBlob } from "./sha256-file";

test("hashBlob matches SHA-256 without joining the file into one buffer", async () => {
  const bytes = Uint8Array.from([97, 98, 99]);
  const digest = await hashBlob(new Blob([bytes.buffer]), { chunkBytes: 1 });
  assert.equal(digest, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("hashBlob stops when the caller cancels", async () => {
  const controller = new AbortController();
  await assert.rejects(
    hashBlob(new Blob([new ArrayBuffer(64)]), {
      chunkBytes: 16,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    }),
    /cancelled/,
  );
});

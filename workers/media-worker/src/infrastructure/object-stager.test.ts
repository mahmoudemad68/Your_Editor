import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { MediaProbeError } from "@editagent/domain";
import { type ObjectByteSource } from "./object-byte-source.js";
import { FileObjectStager } from "./object-stager.js";

function bytes(
  contents: Buffer,
  length: bigint | null = BigInt(contents.length),
): ObjectByteSource {
  return {
    async open() {
      return { stream: Readable.from([contents]), contentLength: length };
    },
  };
}

async function leftovers(root: string): Promise<string[]> {
  const entries = await readdir(root);
  return entries.filter((entry) => entry.startsWith("editagent-probe-"));
}

test("staging writes a server-named file and deletes it on release", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "editagent-stage-"));
  const key = "../../etc/passwd";
  const stager = new FileObjectStager({
    source: {
      async open(storageKey) {
        assert.equal(storageKey, key);
        return bytes(Buffer.from("video-bytes")).open(storageKey);
      },
    },
    rootDir: root,
  });
  const staged = await stager.stage(key);
  assert.equal(staged.filePath.endsWith(`${path.sep}source.bin`), true);
  assert.equal(staged.filePath.includes("passwd"), false);
  assert.equal(await readFile(staged.filePath, "utf8"), "video-bytes");
  await staged.release();
  assert.deepEqual(await leftovers(root), []);
});

test("download and storage failures delete the temporary directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "editagent-stage-"));
  const interrupted = new FileObjectStager({
    source: {
      async open() {
        return {
          stream: Readable.from(
            (async function* () {
              yield Buffer.from("partial");
              throw new Error("connection reset");
            })(),
          ),
          contentLength: 20n,
        };
      },
    },
    rootDir: root,
  });
  await assert.rejects(
    () => interrupted.stage("projects/asset"),
    (error: unknown) => {
      return error instanceof MediaProbeError && error.code === "interrupted";
    },
  );

  const fullDisk = new FileObjectStager({
    source: {
      async open() {
        return {
          stream: Readable.from(
            (async function* () {
              yield Buffer.from("partial");
              const error = new Error("no space") as NodeJS.ErrnoException;
              error.code = "ENOSPC";
              throw error;
            })(),
          ),
          contentLength: 20n,
        };
      },
    },
    rootDir: root,
  });
  await assert.rejects(
    () => fullDisk.stage("projects/asset"),
    (error: unknown) => {
      return error instanceof MediaProbeError && error.code === "insufficient_storage";
    },
  );

  const noRoom = new FileObjectStager({
    source: bytes(Buffer.from("video-bytes")),
    rootDir: root,
    freeBytes: async () => 0n,
  });
  await assert.rejects(
    () => noRoom.stage("projects/asset"),
    (error: unknown) => {
      return (
        error instanceof MediaProbeError &&
        error.code === "insufficient_storage" &&
        error.message === "Media inspection failed."
      );
    },
  );
  assert.deepEqual(await leftovers(root), []);

  const missing = new FileObjectStager({
    source: {
      async open() {
        throw new MediaProbeError("object_missing");
      },
    },
    rootDir: root,
  });
  await assert.rejects(
    () => missing.stage("projects/missing"),
    (error: unknown) => {
      return error instanceof MediaProbeError && error.code === "object_missing";
    },
  );
  assert.deepEqual(await leftovers(root), []);
});

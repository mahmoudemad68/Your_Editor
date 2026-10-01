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

test("a temp-directory failure destroys the opened object stream", async () => {
  const stream = Readable.from([Buffer.from("video-bytes")]);
  let opened = false;
  const stager = new FileObjectStager({
    source: {
      async open() {
        opened = true;
        return { stream, contentLength: 11n };
      },
    },
    rootDir: "/tmp/editagent-missing-probe-root/does-not-exist",
  });
  await assert.rejects(
    () => stager.stage("projects/asset"),
    (error: unknown) => {
      return (
        error instanceof MediaProbeError &&
        error.code === "interrupted" &&
        error.message === "Media inspection failed." &&
        !error.message.includes("ENOENT")
      );
    },
  );
  assert.equal(opened, true);
  assert.equal(stream.destroyed, true);
});

test("download and storage failures delete the temporary directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "editagent-stage-"));
  let interruptedStream: Readable | undefined;
  const interrupted = new FileObjectStager({
    source: {
      async open() {
        interruptedStream = Readable.from(
          (async function* () {
            yield Buffer.from("partial");
            throw new Error("connection reset");
          })(),
        );
        return { stream: interruptedStream, contentLength: 20n };
      },
    },
    rootDir: root,
  });
  await assert.rejects(
    () => interrupted.stage("projects/asset"),
    (error: unknown) => {
      return (
        error instanceof MediaProbeError &&
        error.code === "interrupted" &&
        error.message === "Media inspection failed." &&
        !error.message.includes("connection reset")
      );
    },
  );
  assert.equal(interruptedStream?.destroyed, true);

  let fullStream: Readable | undefined;
  const fullDisk = new FileObjectStager({
    source: {
      async open() {
        fullStream = Readable.from(
          (async function* () {
            yield Buffer.from("partial");
            const error = new Error("no space") as NodeJS.ErrnoException;
            error.code = "ENOSPC";
            throw error;
          })(),
        );
        return { stream: fullStream, contentLength: 20n };
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
  assert.equal(fullStream?.destroyed, true);

  let capped: Readable | undefined;
  const tooLarge = new FileObjectStager({
    source: {
      async open() {
        capped = Readable.from([Buffer.from("0123456789")]);
        return { stream: capped, contentLength: 10n };
      },
    },
    rootDir: root,
    maxBytes: 4n,
  });
  await assert.rejects(
    () => tooLarge.stage("projects/asset"),
    (error: unknown) => error instanceof MediaProbeError && error.code === "invalid_result",
  );
  assert.equal(capped?.destroyed, true);

  let unknownLength: Readable | undefined;
  const unknown = new FileObjectStager({
    source: {
      async open() {
        unknownLength = Readable.from([Buffer.from("video-bytes")]);
        return { stream: unknownLength, contentLength: null };
      },
    },
    rootDir: root,
  });
  const stagedUnknown = await unknown.stage("projects/asset");
  assert.equal(await readFile(stagedUnknown.filePath, "utf8"), "video-bytes");
  await stagedUnknown.release();
  assert.equal(unknownLength?.destroyed, true);

  let noRoomStream: Readable | undefined;
  const noRoom = new FileObjectStager({
    source: {
      async open() {
        noRoomStream = Readable.from([Buffer.from("video-bytes")]);
        return { stream: noRoomStream, contentLength: 11n };
      },
    },
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
  assert.equal(noRoomStream?.destroyed, true);
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

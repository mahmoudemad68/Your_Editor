import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { privateAsrTest } from "./support/private-asr-diagnostics.mjs";

test("analysis integration keeps genuine failure operands private without passing the test", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "asr-private-report-"));
  const destination = pathToFileURL(directory + path.sep);
  const marker = "independently-created-private-test-sentinel";
  try {
    await assert.rejects(
      privateAsrTest(async () => {
        assert.equal(marker, "different synthetic value");
      }, destination),
      (error) =>
        error instanceof Error &&
        error.message === "Real analysis integration failed; raw diagnostics remain local." &&
        !String(error.stack).includes(marker) &&
        error.cause === undefined,
    );
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    assert.ok((await readFile(path.join(directory, files[0]), "utf8")).includes(marker));
    assert.equal((await stat(path.join(directory, files[0]))).mode & 0o777, 0o600);
    assert.equal(await privateAsrTest(async () => "successful", destination), "successful");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

test("real curl retries TLS resets and partial downloads while retaining integrity", () => {
  const result = spawnSync(
    "python3",
    [path.resolve(import.meta.dirname, "../../tools/test/ffmpeg-download-controls.py")],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}${result.error ?? ""}`);
  assert.match(result.stderr, /Ran 8 tests/);
});

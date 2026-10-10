import { test } from "node:test";
import assert from "node:assert/strict";
import { boundaryViolations, checkRepository } from "../../tools/architecture/ffmpeg-boundary.mjs";

test("production FFmpeg execution is owned exclusively by media-core", () => {
  assert.deepEqual(checkRepository(), []);
});
test("lint prevents a new subprocess owner, direct FFmpeg, and Python bypass", () => {
  for (const source of [
    'import {spawn} from "node:child_process"; spawn(exe, []);',
    'spawn("ffmpeg", []);',
    "execFile(ffmpeg, []);",
  ])
    assert.ok(boundaryViolations(source, "workers/new/src/adapter.ts").length);
  assert.ok(boundaryViolations("execv(argv[0], argv);", "workers/new/adapter.c").length);
  assert.ok(boundaryViolations("subprocess.Popen(args)", "workers/ai-worker/src/extra.py").length);
  assert.deepEqual(
    boundaryViolations(
      'import {spawn} from "node:child_process";',
      "packages/media-core/src/ffmpeg-executor.ts",
    ),
    [],
  );
});

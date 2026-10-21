import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("the resolved worker test task receives the repository's real-inference partition options", () => {
  // Resolve the actual strict-mode Turbo task without running models or services.
  // The independent required matrix removes this variable and runs every real test.
  const output = execFileSync(
    process.execPath,
    [
      path.join(root, "node_modules/turbo/bin/turbo"),
      "run",
      "test",
      "--filter=@editagent/ai-worker",
      "--dry=json",
    ],
    {
      cwd: root,
      env: { ...process.env, PYTEST_ADDOPTS: "--collect-only", TURBO_TELEMETRY_DISABLED: "1" },
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const worker = JSON.parse(output).tasks.find(
    (task) => task.taskId === "@editagent/ai-worker#test",
  );
  assert.ok(worker, "The production AI worker test task must be planned.");
  assert.ok(
    worker.environmentVariables.passthrough?.some((entry) => entry.startsWith("PYTEST_ADDOPTS=")),
    "Strict-mode execution must forward the repository's partition options to pytest.",
  );
});

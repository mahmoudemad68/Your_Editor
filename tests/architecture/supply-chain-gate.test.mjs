/**
 * A failed image scan must not reach docker push.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function runPublish(scanDir) {
  const directory = mkdtempSync(path.join(tmpdir(), "editagent-publish-"));
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  const log = path.join(directory, "docker.log");
  writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`,
  );
  chmodSync(path.join(bin, "docker"), 0o755);
  const result = spawnSync(path.join(root, "infra/scripts/publish-scanned-images.sh"), {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      SCAN_DIR: scanDir,
      IMAGE_DIR: directory,
      IMAGE_REGISTRY: "ghcr.io/example",
      IMAGE_SHA: "abc",
    },
  });
  return { ...result, logExists: existsSync(log) };
}

test("a failed SeaweedFS scan blocks every image publish", () => {
  const scanDir = mkdtempSync(path.join(tmpdir(), "editagent-scans-"));
  for (const service of [
    "api",
    "web",
    "media-worker",
    "render-worker",
    "agent-worker",
    "ai-worker",
    "object-ingress",
    "postgres",
    "redis",
  ]) {
    writeFileSync(path.join(scanDir, service), "pass\n");
  }
  writeFileSync(path.join(scanDir, "seaweedfs"), "fail\n");
  const result = runPublish(scanDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rejected seaweedfs/);
  assert.equal(result.stdout.includes("published scanned images"), false);
  assert.equal(result.logExists, false);
});

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

const allowed = new Set([
  "apps/api/src/infrastructure/config.ts",
  "apps/web/src/infrastructure/config.ts",
  "apps/web/src/instrumentation.ts",
  "workers/agent-worker/src/infrastructure/config.ts",
  "workers/media-worker/src/infrastructure/config.ts",
  "workers/render-worker/src/infrastructure/config.ts",
  "workers/ai-worker/src/editagent_ai_worker/infrastructure/config.py",
]);

const pattern = /process\.env|os\.environ|os\.getenv/;

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const fullPath = path.join(directory, entry);
    if (
      entry === "node_modules" ||
      entry === "dist" ||
      entry === "dist-test" ||
      entry === ".next" ||
      entry === ".venv" ||
      entry === "__pycache__" ||
      entry === "tests"
    ) {
      continue;
    }
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...walk(fullPath));
      continue;
    }
    if (/\.(test|spec)\.(ts|tsx|py|mjs)$/.test(entry)) {
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".tsx") || entry.endsWith(".py")) {
      files.push(path.relative(root, fullPath).split(path.sep).join("/"));
    }
  }
  return files;
}

test("runtime configuration is read only at the configuration boundary", () => {
  const roots = ["apps", "packages", "workers"].map((directory) => path.join(root, directory));
  const offenders = [];
  for (const directory of roots) {
    for (const relative of walk(directory)) {
      if (allowed.has(relative)) {
        continue;
      }
      const source = readFileSync(path.join(root, relative), "utf8");
      if (pattern.test(source)) {
        offenders.push(relative);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

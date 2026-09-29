import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const modules = [
  "Identity",
  "Projects",
  "Media",
  "Analysis",
  "Editing",
  "Tools",
  "Agent",
  "Rendering",
  "Assets",
  "Components",
  "Critic",
  "Jobs",
];

function storyIdsFromBacklog() {
  const backlog = path.join(root, "docs/roadmap/backlog/phases");
  const ids = [];
  for (const file of readdirSync(backlog)) {
    if (!file.endsWith(".yaml")) {
      continue;
    }
    const text = readFileSync(path.join(backlog, file), "utf8");
    for (const match of text.matchAll(/^\s*- id: (US-\d+)\s*$/gm)) {
      const id = match[1];
      if (id) {
        ids.push(id);
      }
    }
  }
  return ids;
}

test("every planned story has exactly one owning module", () => {
  const matrix = readFileSync(path.join(root, "docs/architecture/modules.md"), "utf8");
  const owners = new Map();
  const row = new RegExp(
    `^\\|\\s*(US-\\d+)\\s*\\|\\s*[^|]+?\\s*\\|\\s*(${modules.join("|")})\\s*\\|\\s*(capability|governance|runtime)\\s*\\|$`,
    "gm",
  );
  for (const match of matrix.matchAll(row)) {
    const id = match[1];
    const moduleName = match[2];
    assert.ok(id);
    assert.ok(moduleName);
    assert.equal(owners.has(id), false, `${id} is listed more than once`);
    owners.set(id, moduleName);
  }

  const stories = storyIdsFromBacklog();
  assert.ok(stories.length > 0);
  const missing = stories.filter((id) => !owners.has(id));
  const extra = [...owners.keys()].filter((id) => !stories.includes(id));
  assert.deepEqual(missing, [], `stories missing from the ownership matrix: ${missing.join(", ")}`);
  assert.deepEqual(extra, [], `matrix rows that are not planned stories: ${extra.join(", ")}`);
  assert.equal(owners.size, stories.length);
});

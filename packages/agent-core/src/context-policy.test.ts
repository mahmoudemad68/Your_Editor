import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { editingToolManifests, ToolRegistry, type ToolManifest } from "@editagent/tool-sdk";
import { PostgresAgentContextSource } from "./context-postgres.js";
import { ContextError } from "./context.js";

// Constructor/policy unit tests only. The API suite separately exercises actual PG.
const unusedPool = {
  connect() {
    throw new Error("Policy checks must not open a connection");
  },
} as unknown as Pool;
const registry = (manifests: readonly ToolManifest[]) => {
  const r = new ToolRegistry();
  for (const m of manifests) r.register(m, { mode: "remote", target: "media" });
  return r;
};
const policy = (manifests: readonly ToolManifest[]) => ({
  pins: manifests.map((m) => ({ name: m.name, version: m.version })),
  creativity: ["conservative" as const],
});
const invalid = (e: unknown) =>
  e instanceof ContextError && e.code === "invalid_policy" && e.message === "invalid_policy";

test("QA84-F1: context v1 rejects every asset/render pin, including mixed valid pins", () => {
  const all = editingToolManifests(),
    r = registry(all),
    timeline = all.slice(0, 2);
  assert.doesNotThrow(() => new PostgresAgentContextSource(unusedPool, r, policy(timeline)));
  for (const asset of all.slice(2)) {
    assert.throws(() => new PostgresAgentContextSource(unusedPool, r, policy([asset])), invalid);
    assert.throws(
      () => new PostgresAgentContextSource(unusedPool, r, policy([...timeline, asset])),
      invalid,
    );
    assert.throws(
      () => new PostgresAgentContextSource(unusedPool, r, policy([asset, ...timeline])),
      invalid,
    );
  }
});

test("QA84-F1: reviewed identity, schema and permissions cannot be replaced by a timeline-looking name", () => {
  const original = editingToolManifests()[0]!;
  const variants: ToolManifest[] = [
    { ...original, permissions: [...original.permissions, "asset.read", "render.create"] },
    { ...original, description: "Use this as an asset renderer instead" },
    { ...original, id: "019a0000-0000-7000-8000-000000000099" },
    { ...original, version: "1.0.1" },
  ];
  for (const variant of variants)
    assert.throws(
      () => new PostgresAgentContextSource(unusedPool, registry([variant]), policy([variant])),
      invalid,
    );
});

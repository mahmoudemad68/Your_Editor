import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createHttpProjectApi } from "./project-api";

test("production web source does not bind a test actor", () => {
  const root = path.resolve(__dirname, "../../src");
  const files = readdirSync(root, { recursive: true, encoding: "utf8" });
  for (const file of files) {
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) {
      continue;
    }
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) {
      continue;
    }
    const text = readFileSync(path.join(root, file), "utf8");
    assert.equal(text.includes("x-test-actor"), false, file);
  }
});

test("the production project client does not send an identity header", async () => {
  const source = readFileSync(
    path.resolve(__dirname, "../../src/infrastructure/project-api.ts"),
    "utf8",
  );
  const actions = readFileSync(
    path.resolve(__dirname, "../../src/composition/project-actions.ts"),
    "utf8",
  );
  assert.equal(source.includes("x-test-actor"), false);
  assert.equal(actions.includes("x-test-actor"), false);
  let seen: Headers | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    seen = new Headers(init?.headers);
    return Response.json({ projects: [] });
  };
  const api = createHttpProjectApi({ baseUrl: "http://api.test", fetchImpl });
  const listed = await api.listProjects();
  assert.equal(listed.ok, true);
  assert.equal(seen?.has("x-test-actor"), false);
  assert.equal(seen?.has("x-user-id"), false);
});

test("delete treats 204 as success and 401 as sign-in required", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return Response.json({ statusCode: 401, message: "Sign in is required." }, { status: 401 });
  };
  const api = createHttpProjectApi({ baseUrl: "http://api.test", fetchImpl });
  const removed = await api.deleteProject("asset");
  assert.deepEqual(removed, { ok: true, data: undefined });
  const denied = await api.listProjects();
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.status, 401);
    assert.equal(denied.message, "Sign in is required.");
  }
});

test("rename uses the generated patch operation", async () => {
  let method = "";
  let body = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request("http://api.test", init);
    method = request.method;
    body = await request.clone().text();
    return Response.json({
      id: "018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f",
      name: "Cut",
      role: "owner",
      createdAt: "1700000000000",
      updatedAt: "1700000000000",
    });
  };
  const api = createHttpProjectApi({ baseUrl: "http://api.test", fetchImpl });
  const renamed = await api.renameProject("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f", "Cut");
  assert.equal(renamed.ok, true);
  assert.equal(method, "PATCH");
  assert.match(body, /"name":"Cut"/);
});

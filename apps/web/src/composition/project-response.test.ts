import assert from "node:assert/strict";
import { test } from "node:test";
import { PROJECT_API_CACHE_CONTROL, projectApiResponse } from "./project-response";

test("project envelopes stay private and uncached, including 401", async () => {
  const denied = projectApiResponse({
    ok: false,
    status: 401,
    message: "Sign in is required.",
  });
  assert.equal(denied.status, 200);
  assert.equal(denied.headers.get("cache-control"), PROJECT_API_CACHE_CONTROL);
  assert.deepEqual(await denied.json(), {
    ok: false,
    status: 401,
    message: "Sign in is required.",
  });

  const listed = projectApiResponse({ ok: true, data: [] });
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("cache-control"), PROJECT_API_CACHE_CONTROL);
  assert.equal(listed.headers.get("cache-control")?.includes("public"), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { CORRELATION_HEADER } from "@editagent/shared";
import { GET as list, POST as create } from "../app/api/projects/route";
import { PATCH as rename, DELETE as remove } from "../app/api/projects/[projectId]/route";
import { POST as begin } from "../app/api/projects/[projectId]/uploads/route";
import { POST as complete } from "../app/api/projects/[projectId]/uploads/complete/route";
import { GET as media } from "../app/api/projects/[projectId]/media/[mediaAssetId]/route";

test("every project route forwards cookies, explicit CSRF and correlation; no ambient CSRF synthesis", async (t) => {
  const previous = process.env.API_BASE_URL;
  process.env.API_BASE_URL = "http://api.test";
  t.after(() => {
    if (previous === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = previous;
  });
  const seen: Headers[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return Response.json({ projects: [] });
  });
  const params = Promise.resolve({ projectId: "project", mediaAssetId: "media" });
  const calls = [list, create, rename, remove, begin, complete, media];
  for (const explicit of [true, false]) {
    for (const call of calls) {
      const request = new Request("http://web.test/api/projects", {
        method: "POST",
        headers: {
          cookie: "editagent_access=opaque; editagent_csrf=ambient",
          [CORRELATION_HEADER]: "request-correlation-123",
          "content-type": "application/json",
          ...(explicit ? { "x-editagent-csrf": "explicit" } : {}),
        },
        body: JSON.stringify({
          name: "Edit",
          filename: "reel.mp4",
          mimeType: "video/mp4",
          byteSize: 10,
          sha256: "ab".repeat(32),
        }),
      });
      await call(request, { params });
      const headers = seen.at(-1)!;
      assert.equal(headers.get(CORRELATION_HEADER), "request-correlation-123");
      assert.equal(headers.get("cookie"), "editagent_access=opaque; editagent_csrf=ambient");
      assert.equal(headers.get("x-editagent-csrf"), explicit ? "explicit" : null);
      assert.equal(headers.has("x-user-id"), false);
    }
  }
  assert.equal(seen.length, calls.length * 2);
});

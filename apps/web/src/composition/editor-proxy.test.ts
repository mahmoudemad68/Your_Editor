import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { proxyEditor } from "./editor-proxy";
const PROJECT = "018f6b6e-7c3a-7000-8000-000000000001",
  ID = "018f6b6e-7c3a-7000-8000-000000000002";
const prior = process.env.API_BASE_URL;
test("caption proxy admits fixed caption paths and source hashes, refuses arbitrary routing", async () => {
  const response = await proxyEditor(
    new Request("http://web.test/", { method: "GET" }),
    PROJECT,
    [ID, "captions", "sources", ID],
    async (url) => {
      assert.equal(
        String(url),
        `http://api.test/projects/${PROJECT}/timelines/${ID}/captions/sources/${ID}`,
      );
      return Response.json({
        assetId: ID,
        sourceSha256: "a".repeat(64),
        analysisSha256: "b".repeat(64),
      });
    },
  );
  assert.equal(response.status, 200);
  const failed = await proxyEditor(
    new Request("http://web.test/", { method: "GET" }),
    PROJECT,
    [ID, "captions", "sources", "https://example.com"],
    async () => {
      throw new Error("Must not fetch");
    },
  );
  assert.equal(failed.status, 400);
});
beforeEach(() => {
  process.env.API_BASE_URL = "http://api.test";
});
afterEach(() => {
  if (prior === undefined) delete process.env.API_BASE_URL;
  else process.env.API_BASE_URL = prior;
});
test("trim conflicts remain 409 while unrelated server errors remain 500 without upstream detail", async () => {
  for (const status of [409, 500]) {
    const response = await proxyEditor(
      new Request("http://web.test/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stateSha256: "a".repeat(64),
          clipId: ID,
          startUs: "0",
          endUs: "1200000",
        }),
      }),
      PROJECT,
      [ID, "trim"],
      async () => Response.json({ message: "private internal failure control" }, { status }),
    );
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.status, status);
    assert.equal(JSON.stringify(body).includes("private internal failure control"), false);
  }
});
test("editor proxy fixes routing and forwards only session/CSRF/correlation headers", async () => {
  const response = await proxyEditor(
    new Request("http://web.test/?url=http://untrusted.test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "synthetic-session",
        "x-editagent-csrf": "synthetic-csrf",
        "x-user-id": "not-an-actor",
      },
      body: JSON.stringify({ mediaAssetId: ID }),
    }),
    PROJECT,
    [],
    async (input, init) => {
      assert.equal(String(input), `http://api.test/projects/${PROJECT}/timelines`);
      const h = new Headers(init?.headers);
      assert.equal(h.get("cookie"), "synthetic-session");
      assert.equal(h.get("x-editagent-csrf"), "synthetic-csrf");
      assert.equal(h.get("x-user-id"), null);
      assert.equal(h.get("authorization"), null);
      assert.equal(init?.redirect, "error");
      assert.equal(init?.cache, "no-store");
      return Response.json({
        timeline: { id: ID, projectId: PROJECT },
        stateSha256: "a".repeat(64),
      });
    },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /private, no-store/);
});
test("path traversal, unknown operations and oversized bodies never reach the API", async () => {
  let calls = 0;
  const fake = async () => {
    calls++;
    return Response.json({});
  };
  for (const parts of [[".."], [ID, "shell"], [ID + "\n"], ["exports", ID, "../download"]])
    assert.equal(
      (await proxyEditor(new Request("http://web.test"), PROJECT, parts, fake)).status,
      400,
    );
  const large = new Request("http://web.test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data: "x".repeat(9000) }),
  });
  assert.equal((await proxyEditor(large, PROJECT, [], fake)).status, 502);
  assert.equal(calls, 0);
});
test("upstream errors and mismatched identities cannot leak internal bodies", async () => {
  for (const parts of [[ID], ["exports", ID]])
    assert.equal(
      (
        await proxyEditor(new Request("http://web.test"), PROJECT, parts, async () =>
          Response.json({}),
        )
      ).status,
      502,
    );
  for (const status of [400, 401, 403, 404, 409, 500, 503]) {
    const response = await proxyEditor(
      new Request("http://web.test"),
      PROJECT,
      [ID],
      async () => new Response("synthetic private diagnostics", { status }),
    );
    assert.equal(response.status, status);
    assert.doesNotMatch(await response.text(), /private diagnostics/);
  }
  const wrong = await proxyEditor(new Request("http://web.test"), PROJECT, [ID], async () =>
    Response.json({ timeline: { id: PROJECT, projectId: PROJECT }, stateSha256: "a".repeat(64) }),
  );
  assert.equal(wrong.status, 502);
  const unsafe = await proxyEditor(
    new Request("http://web.test"),
    PROJECT,
    ["exports", ID, "download"],
    async () =>
      Response.json({ previewUrl: "https://storage.test/a", downloadUrl: "javascript:alert(1)" }),
  );
  assert.equal(unsafe.status, 502);
});

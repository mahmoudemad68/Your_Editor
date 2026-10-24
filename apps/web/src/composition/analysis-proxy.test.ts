import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { proxyMediaAnalysis } from "./analysis-proxy";
import { analysisFixture, ANALYSIS_MEDIA, ANALYSIS_PROJECT } from "../analysis-test-fixture";

const prior = process.env.API_BASE_URL;
beforeEach(() => {
  process.env.API_BASE_URL = "http://api.test";
});
afterEach(() => {
  if (prior === undefined) delete process.env.API_BASE_URL;
  else process.env.API_BASE_URL = prior;
});

test("analysis proxy preserves both schema versions, credentials and private cache boundary", async () => {
  for (const version of ["1.0.0", "1.1.0"]) {
    const request = new Request("http://web.test/?url=http://untrusted.test", {
      headers: {
        cookie: "editagent_access=synthetic-example",
        "x-user-id": "not-an-actor",
        "x-request-id": "analysis-test-request",
        host: "untrusted.test",
      },
    });
    const response = await proxyMediaAnalysis(
      request,
      ANALYSIS_PROJECT,
      ANALYSIS_MEDIA,
      async (input, init) => {
        assert.equal(
          String(input),
          `http://api.test/projects/${ANALYSIS_PROJECT}/media/${ANALYSIS_MEDIA}/analysis`,
        );
        const forwarded = new Headers(init?.headers);
        assert.equal(forwarded.get("cookie"), "editagent_access=synthetic-example");
        assert.equal(forwarded.get("x-request-id"), "analysis-test-request");
        assert.equal(forwarded.get("x-user-id"), null);
        assert.equal(forwarded.get("host"), null);
        assert.equal(init?.cache, "no-store");
        assert.equal(init?.redirect, "error");
        assert.ok(init?.signal);
        return Response.json(analysisFixture(version));
      },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /private, no-store/);
    assert.deepEqual(await response.json(), { ok: true, data: analysisFixture(version) });
  }
});

test("invalid identities never reach the API", async () => {
  let calls = 0;
  const response = await proxyMediaAnalysis(
    new Request("http://web.test"),
    "../other",
    ANALYSIS_MEDIA,
    async () => {
      calls++;
      return Response.json({});
    },
  );
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test("failure companion preserves authentication and reconstructs only allowlisted content", async () => {
  const response = await proxyMediaAnalysis(
    new Request("http://web.test", { headers: { cookie: "session=opaque" } }),
    ANALYSIS_PROJECT,
    ANALYSIS_MEDIA,
    async (url, init) => {
      assert.match(String(url), /\/analysis\/failures$/);
      assert.equal(new Headers(init?.headers).get("cookie"), "session=opaque");
      return Response.json({
        mediaAssetId: ANALYSIS_MEDIA,
        sourceSha256: "a".repeat(64),
        failures: [
          {
            analyzer: "transcript",
            category: "authorization_revoked",
            message: "private account",
            trace: "private",
          },
        ],
      });
    },
    true,
  );
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(body.includes("authorization_revoked"));
  assert.ok(!body.includes("private account"));
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("authorization, missing analysis and upstream errors retain status without leaking bodies", async () => {
  for (const status of [401, 403, 404, 500]) {
    const response = await proxyMediaAnalysis(
      new Request("http://web.test"),
      ANALYSIS_PROJECT,
      ANALYSIS_MEDIA,
      async () => new Response("synthetic internal upstream details", { status }),
    );
    assert.equal(response.status, status);
    const text = await response.text();
    assert.doesNotMatch(text, /internal upstream/);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }
});

test("invalid schema and another asset's document cannot become successful analysis", async () => {
  for (const document of [
    { schemaVersion: "future" },
    { ...analysisFixture(), mediaAssetId: ANALYSIS_PROJECT },
  ]) {
    const response = await proxyMediaAnalysis(
      new Request("http://web.test"),
      ANALYSIS_PROJECT,
      ANALYSIS_MEDIA,
      async () => Response.json(document),
    );
    assert.equal(response.status, 502);
    assert.equal((await response.json()).ok, false);
  }
});

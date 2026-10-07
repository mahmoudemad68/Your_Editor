import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { proxyInspectionJob, proxyJobEvents } from "./job-proxy";
const oldBase = process.env.API_BASE_URL;
beforeEach(() => {
  process.env.API_BASE_URL = "http://api.test";
});
afterEach(() => {
  if (oldBase === undefined) delete process.env.API_BASE_URL;
  else process.env.API_BASE_URL = oldBase;
});
const PROJECT = "018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f";
test("BFF fixed route streams early bytes, safe cookies/correlation and downstream cancellation", async () => {
  let upstreamSignal: AbortSignal | null | undefined,
    cancelled = 0,
    sentHeaders: Headers | undefined,
    url = "";
  const incoming = new Request("http://web.test/api/ignored?url=http://evil.test", {
    headers: {
      cookie: "editagent_access=secret",
      host: "evil.test",
      "x-forwarded-host": "evil.test",
      "x-request-id": "valid-correlation",
    },
  });
  const response = await proxyJobEvents(incoming, PROJECT, async (input, init) => {
    url = String(input);
    sentHeaders = new Headers(init?.headers);
    upstreamSignal = init?.signal;
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(": early\n\n"));
        },
        cancel() {
          cancelled++;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  assert.ok(url.endsWith(`/projects/${PROJECT}/jobs/events`));
  assert.doesNotMatch(url, /evil/);
  assert.equal(sentHeaders?.get("cookie"), "editagent_access=secret");
  assert.equal(sentHeaders?.get("host"), null);
  assert.equal(sentHeaders?.get("x-forwarded-host"), null);
  assert.equal(sentHeaders?.get("x-request-id"), "valid-correlation");
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), ": early\n\n");
  await reader.cancel();
  assert.equal(upstreamSignal?.aborted, true);
  assert.equal(cancelled, 1);
});
test("BFF preserves authentication/non-disclosure statuses and rejects invalid project before fetching", async () => {
  for (const status of [401, 404, 503]) {
    const r = await proxyJobEvents(
      new Request("http://web.test/"),
      PROJECT,
      async () => new Response(null, { status }),
    );
    assert.equal(r.status, status);
  }
  let fetched = false;
  assert.equal(
    (
      await proxyJobEvents(new Request("http://web.test/"), "https://evil", async () => {
        fetched = true;
        return new Response();
      })
    ).status,
    400,
  );
  assert.equal(fetched, false);
});
test("BFF downstream request abort propagates upstream; retry forwards CSRF, no arbitrary body/policy", async () => {
  const controller = new AbortController();
  let upstreamSignal: AbortSignal | null | undefined;
  const response = await proxyJobEvents(
    new Request("http://web.test/", { signal: controller.signal }),
    PROJECT,
    async (_u, init) => {
      upstreamSignal = init?.signal;
      return new Response(
        new ReadableStream({
          start(c) {
            init?.signal?.addEventListener("abort", () => c.close());
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  );
  controller.abort();
  assert.equal(upstreamSignal?.aborted, true);
  await response.body?.cancel();
  await proxyInspectionJob(
    new Request("http://web.test/", {
      method: "POST",
      headers: { cookie: "session", "x-editagent-csrf": "csrf" },
      body: '{"queue":"evil"}',
    }),
    PROJECT,
    PROJECT,
    true,
    async (u, init) => {
      assert.ok(String(u).endsWith("/inspection/retry"));
      assert.equal(new Headers(init?.headers).get("x-editagent-csrf"), "csrf");
      assert.equal(init?.body, undefined);
      return Response.json({ jobId: PROJECT });
    },
  );
});

import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { proxyInspectionJob, proxyJobEvents } from "./job-proxy";
import {
  JobStreamRegistry,
  jobStreamRegistry,
  MAX_ACTIVE_JOB_PROXY_STREAMS,
} from "../infrastructure/job-stream-lifecycle";
import { EventEmitter } from "node:events";
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
  assert.equal(jobStreamRegistry.count, 0);
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
  assert.equal(jobStreamRegistry.count, 0);
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
  assert.equal(jobStreamRegistry.count, 0);
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
test("bounded active-stream registry installs one signal pair and aborts all idempotently", () => {
  const registry = new JobStreamRegistry();
  const signals = new EventEmitter();
  registry.install(signals as NodeJS.Process);
  registry.install(signals as NodeJS.Process);
  assert.equal(signals.listenerCount("SIGTERM"), 1);
  assert.equal(signals.listenerCount("SIGINT"), 1);
  const controllers = Array.from(
    { length: MAX_ACTIVE_JOB_PROXY_STREAMS },
    () => new AbortController(),
  );
  for (const controller of controllers) assert.ok(registry.register(controller));
  assert.equal(registry.register(new AbortController()), null, "registry has a hard capacity");
  signals.emit("SIGTERM");
  assert.equal(registry.count, 0);
  assert.ok(controllers.every((controller) => controller.signal.aborted));
  signals.emit("SIGINT");
  assert.equal(registry.count, 0);
  assert.equal(registry.register(new AbortController()), null, "shutdown admits no new streams");
});
test("BFF unregisters on EOF and upstream read failure; repeated cancellation is harmless", async () => {
  for (const fail of [false, true]) {
    const response = await proxyJobEvents(
      new Request("http://web.test/"),
      PROJECT,
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              if (fail) controller.error(new Error("unsafe internal details"));
              else controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    await response.text().catch(() => undefined);
    assert.equal(jobStreamRegistry.count, 0);
  }
  const registry = new JobStreamRegistry();
  const controller = new AbortController();
  const unregister = registry.register(controller)!;
  unregister();
  unregister();
  assert.equal(registry.count, 0);
  assert.equal(registry.shutdown(), 0);
});

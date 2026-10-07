import assert from "node:assert/strict";
import { test } from "node:test";
import { SseParser, type SseFrame } from "./sse-parser";
import { parseJobEvent, ProjectJobEventStream } from "./job-event-stream";
import { SessionClient } from "./session-client";
const PROJECT = "018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f";
const event = {
  schemaVersion: 1,
  jobId: PROJECT,
  projectId: PROJECT,
  jobType: "media.inspect",
  kind: "progress",
  sequence: 1,
  attempt: 1,
  percentage: 25,
  stage: "proxy",
  occurredAt: new Date().toISOString(),
  eventId: `${PROJECT}:1`,
};
test("fragmentation, multiple frames, comments, CR/LF, multiline data and EOF", () => {
  const frames: SseFrame[] = [];
  const parser = new SseParser((f) => frames.push(f));
  for (const part of [
    ": heart\r",
    "\nevent: j",
    'ob\r\nid: 1\r\ndata: {"a":\r\n',
    "data: 1}\r\n\r\n: heartbeat\n\nevent: job\ndata: second",
  ])
    parser.feed(part);
  parser.end();
  assert.deepEqual(frames, [
    { event: "job", data: '{"a":\n1}', id: "1" },
    { event: "job", data: "second", id: "" },
  ]);
});
test("UTF-8 streaming, invalid JSON/schema, unsafe fields, wrong project and oversized discarded", () => {
  const frames: SseFrame[] = [];
  const parser = new SseParser((f) => frames.push(f));
  const bytes = new TextEncoder().encode("event: job\ndata: café\n\n");
  const decoder = new TextDecoder();
  for (const byte of bytes) parser.feed(decoder.decode(new Uint8Array([byte]), { stream: true }));
  parser.feed(decoder.decode());
  assert.equal(frames[0]?.data, "café");
  assert.ok(parseJobEvent(JSON.stringify(event), PROJECT));
  for (const bad of [
    "{",
    JSON.stringify({ ...event, percentage: 101 }),
    JSON.stringify({ ...event, stage: "secret path" }),
    JSON.stringify({ ...event, payload: { secret: 1 } }),
    JSON.stringify({ ...event, attempt: 0 }),
  ])
    assert.equal(parseJobEvent(bad, PROJECT), null);
  assert.equal(parseJobEvent(JSON.stringify(event), "other"), null);
  const bounded = new SseParser((f) => frames.push(f), 20);
  bounded.feed("data: " + "x".repeat(100) + "\nevent: job\n\ndata: valid\n\n");
  assert.equal(frames.length, 2);
  assert.equal(frames[1]?.data, "valid");
});
test("SessionClient does not consume live stream JSON or apply default timeout", async () => {
  const abort = new AbortController();
  let signal: AbortSignal | null | undefined;
  const session = new SessionClient(async (_url, init) => {
    signal = init?.signal;
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const response = await session.authenticatedFetch("/api/projects/p/jobs/events", {
    signal: abort.signal,
  });
  assert.equal(signal, abort.signal);
  await response.body?.cancel();
  abort.abort();
});
test("one project stream for multiple consumers, unexpected types ignored, abort releases reader/session", async () => {
  let opened = 0,
    cancelled = 0,
    signal: AbortSignal | undefined,
    sessionListener: (() => void) | undefined;
  const received: number[] = [];
  const stream = new ProjectJobEventStream({
    getSnapshot: () => ({ status: "checking" }),
    subscribe: (f) => {
      sessionListener = f;
      return () => {
        sessionListener = undefined;
      };
    },
    authenticatedFetch: async (_url, init) => {
      opened++;
      signal = init?.signal as AbortSignal;
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                `event: other\ndata: ${JSON.stringify(event)}\n\nevent: job\ndata: ${JSON.stringify(event)}\n\n`,
              ),
            );
            signal?.addEventListener("abort", () => c.close(), { once: true });
          },
          cancel() {
            cancelled++;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const a = stream.subscribe(PROJECT, { event: () => received.push(1), reconcile: () => {} }),
    b = stream.subscribe(PROJECT, { event: () => received.push(2), reconcile: () => {} });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(opened, 1);
  assert.deepEqual(received, [1, 2]);
  a();
  assert.equal(signal?.aborted, false);
  b();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(signal?.aborted, true);
  assert.equal(sessionListener, undefined);
  assert.ok(cancelled <= 1);
});

test("EOF reconnect uses bounded backoff and requests authoritative reconciliation on each open", async () => {
  let opened = 0,
    reconciled = 0,
    received = 0;
  const times: number[] = [];
  const stream = new ProjectJobEventStream({
    getSnapshot: () => ({ status: "checking" }),
    subscribe: () => () => {},
    authenticatedFetch: async (_url, init) => {
      opened++;
      times.push(Date.now());
      return new Response(
        new ReadableStream({
          start(controller) {
            if (opened === 1) controller.close();
            else {
              controller.enqueue(
                new TextEncoder().encode(`event: job\ndata: ${JSON.stringify(event)}\n\n`),
              );
              init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
            }
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const stop = stream.subscribe(PROJECT, {
    event: () => {
      received++;
    },
    reconcile: () => {
      reconciled++;
    },
  });
  try {
    const deadline = Date.now() + 2000;
    while (!received && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.equal(opened, 2);
    assert.equal(reconciled, 2);
    assert.equal(received, 1);
    assert.ok(times[1]! - times[0]! >= 240);
  } finally {
    stop();
  }
});

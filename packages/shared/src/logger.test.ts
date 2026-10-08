import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";

import { createServiceLogger, logWithCorrelation } from "./logger.js";
import { startNoopTracing } from "./tracing.js";

test("log lines are JSON and include the correlation id", () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString("utf8"));
      callback();
    },
  });
  const logger = createServiceLogger("api", stream);
  logWithCorrelation(logger, "web-request-1", "job.accepted", {
    jobType: "media.inspect",
    subjectId: "asset-1",
  });
  logWithCorrelation(logger, "web-request-1", "job.finished", { jobType: "media.inspect" });
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const parsed = JSON.parse(line) as { correlationId?: string; message?: string; stack?: string };
    assert.equal(parsed.correlationId, "web-request-1");
    assert.equal(typeof parsed.message, "string");
    assert.equal("stack" in parsed, false);
  }
  assert.throws(() => logWithCorrelation(logger, "bad id", "nope"));
});

test("noop tracing can be started more than once", () => {
  startNoopTracing("api");
  startNoopTracing("media-worker");
});

test("representative errors cannot introduce request/credential objects into JSON logs", () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  const logger = createServiceLogger("api", stream);
  logger.error(
    {
      correlationId: "safe-request",
      errorCode: "internal_error",
      err: new Error("SECRET_CANARY password=not-for-logs /tmp/file SELECT secret"),
      Authorization: "Bearer private",
      Cookie: "session=private",
      password: "private",
      access_token: "private",
      refresh_token: "private",
      csrf: "private",
      request: { headers: { authorization: "private" }, body: { password: "private" } },
      url: "https://store/object?X-Amz-Credential=private&X-Amz-Signature=private",
    },
    "operation.failed",
  );
  const encoded = lines.join("");
  for (const value of [
    "private",
    "SECRET_CANARY",
    "password",
    "Bearer",
    "SELECT",
    "/tmp/file",
    "X-Amz",
    "stack",
  ])
    assert.equal(encoded.includes(value), false);
  assert.equal(JSON.parse(encoded).correlationId, "safe-request");
  assert.equal(JSON.parse(encoded).errorCode, "internal_error");
});

test("OpenTelemetry SDK initialization/spans create no network clients", async () => {
  const { channel } = await import("node:diagnostics_channel");
  const { trace } = await import("@opentelemetry/api");
  const network = channel("net.client.socket");
  let attempts = 0;
  const record = () => {
    attempts++;
  };
  network.subscribe(record);
  try {
    startNoopTracing("api");
    const provider = trace.getTracerProvider();
    startNoopTracing("web");
    assert.equal(trace.getTracerProvider(), provider);
    trace.getTracer("baseline").startSpan("no-export").end();
    assert.equal(attempts, 0);
  } finally {
    network.unsubscribe(record);
  }
});

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

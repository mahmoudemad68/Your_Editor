import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acceptCorrelationId,
  bindCorrelationId,
  createCorrelationId,
  createLoggedJob,
  currentCorrelationId,
  parseLoggedJob,
} from "./correlation.js";

test("correlation ids accept a web request id and reject log-breaking text", () => {
  assert.equal(acceptCorrelationId("web-request-1"), "web-request-1");
  assert.equal(acceptCorrelationId("  "), null);
  assert.equal(acceptCorrelationId("bad id"), null);
  assert.equal(acceptCorrelationId("line\nbreak"), null);
  const generated = createCorrelationId();
  assert.equal(acceptCorrelationId(generated), generated);
});

test("a job payload keeps the request correlation id", () => {
  const job = createLoggedJob({
    correlationId: "web-request-1",
    jobType: " media.inspect ",
    subjectId: " asset ",
  });
  assert.deepEqual(job, {
    correlationId: "web-request-1",
    jobType: "media.inspect",
    subjectId: "asset",
  });
  assert.deepEqual(parseLoggedJob(JSON.stringify(job)), job);
  assert.throws(() => createLoggedJob({ correlationId: "bad id", jobType: "x", subjectId: "y" }));
});

test("the current correlation id follows the bound request", () => {
  assert.equal(currentCorrelationId(), undefined);
  bindCorrelationId("web-request-1");
  assert.equal(currentCorrelationId(), "web-request-1");
});

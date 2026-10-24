import assert from "node:assert/strict";
import { test } from "node:test";
import { AnalysisAdmissionError } from "@editagent/analysis-core";
import { JobTimeoutError, JobCancelledError, PermanentJobError } from "@editagent/job-queue";
import { audioFailureCategory, audioFailureRetryable } from "./analysis-audio.js";

test("audio timeout, cancellation, revoked publication and unknown errors stay distinct", () => {
  const active = new AbortController();
  for (const [error, category] of [
    [new JobTimeoutError(), "timeout"],
    [new JobCancelledError(), "cancelled"],
    [new AnalysisAdmissionError("authorization_revoked"), "authorization_revoked"],
    [{ code: "EA001", message: "private" }, "authorization_revoked"],
    [new PermanentJobError("private"), "invalid_input"],
    [{ code: "ECONNRESET" }, "analyzer_unavailable"],
    [new Error("private storage key"), "internal"],
  ] as const)
    assert.equal(audioFailureCategory(error, active.signal), category);
  active.abort(new JobTimeoutError());
  assert.equal(audioFailureCategory(new Error("aborted"), active.signal), "timeout");
});

test("service transport timeouts and retryable HTTP failures do not become inference timeouts", () => {
  const signal = new AbortController().signal;
  const transport = Object.assign(new Error("private"), { name: "TimeoutError" });
  assert.equal(audioFailureCategory(transport, signal), "analyzer_unavailable");
  for (const status of [403, 404, 429, 503]) {
    const error = { $metadata: { httpStatusCode: status } };
    assert.equal(audioFailureCategory(error, signal), "analyzer_unavailable");
    assert.equal(
      audioFailureRetryable(error, "analyzer_unavailable"),
      status === 429 || status >= 500,
    );
  }
});

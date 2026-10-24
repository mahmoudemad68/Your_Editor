import assert from "node:assert/strict";
import { test } from "node:test";
import { ANALYSIS_FAILURES, failureDetail, legacyAnalysisFailure } from "./failures.js";
import { parseAnalysisFailureDetails } from "@editagent/schemas";

test("every specific category projects to a compatible bounded legacy failure", () => {
  for (const category of Object.keys(ANALYSIS_FAILURES) as (keyof typeof ANALYSIS_FAILURES)[]) {
    const legacy = legacyAnalysisFailure(category);
    assert.ok(
      ["invalid_input", "unsupported", "timeout", "unavailable", "internal"].includes(legacy.code),
    );
    assert.ok(legacy.reason.length < 100);
    assert.equal(legacy.retryable, category === "analyzer_unavailable");
  }
  assert.equal(legacyAnalysisFailure("untrustworthy_alignment").code, "unsupported");
  assert.equal(legacyAnalysisFailure("authorization_revoked").code, "unavailable");
  assert.equal(failureDetail("private stack trace").category, "internal");
});
test("companion parser reconstructs safe messages and rejects unbounded or duplicate data", () => {
  const input = {
    mediaAssetId: "01900000-0000-7000-8000-000000000001",
    sourceSha256: "a".repeat(64),
    failures: [
      {
        analyzer: "transcript",
        category: "untrustworthy_alignment",
        message: "private transcript secret",
        storageKey: "private",
      },
    ],
  };
  const output = parseAnalysisFailureDetails(input);
  assert.ok(!JSON.stringify(output).includes("private"));
  assert.equal(output.failures[0]?.category, "untrustworthy_alignment");
  assert.throws(() =>
    parseAnalysisFailureDetails({ ...input, failures: [...input.failures, ...input.failures] }),
  );
  assert.throws(() => parseAnalysisFailureDetails({ ...input, sourceSha256: "invalid" }));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertBrokenMetadataProof } from "../../tools/test/walking-skeleton-proof.mjs";
const marker = "metadata Job must complete; inspect media-worker/queue diagnostics on timeout";
const report = (message, status = "failed") => ({
  errors: [],
  suites: [
    {
      specs: [
        {
          tests: [
            { results: [{ status, errors: [{ message }], attachments: [{ body: marker }] }] },
          ],
        },
      ],
    },
  ],
  source: marker,
});
test("negative proof accepts only the actual failed metadata assertion", () => {
  assert.doesNotThrow(() => assertBrokenMetadataProof(report(`Error: ${marker}`), 1));
  for (const [data, code] of [
    [report("page.goto: net::ERR_ABORTED"), 1],
    [report(marker, "passed"), 0],
    [report(marker, "timedOut"), 1],
    [{ ...report(marker), errors: [{ message: "browser startup failed" }] }, 1],
    [{ suites: [], source: marker }, 1],
    [report(marker), null],
  ])
    assert.throws(
      () => assertBrokenMetadataProof(data, code),
      /did not fail at the metadata assertion/,
    );
});

/** Verify execution errors only: report sources/attachments can contain this text
 * even when authentication/startup failed, and must never count as evidence. */
export function assertBrokenMetadataProof(report, exitCode) {
  const results = [];
  function suites(items) {
    for (const suite of items ?? []) {
      for (const spec of suite.specs ?? [])
        for (const test of spec.tests ?? []) results.push(...(test.results ?? []));
      suites(suite.suites);
    }
  }
  suites(report.suites);
  const [result] = results;
  const errors = result?.errors?.length ? result.errors : [result?.error];
  const marker = "metadata Job must complete; inspect media-worker/queue diagnostics on timeout";
  if (
    exitCode !== 1 ||
    report.errors?.length ||
    results.length !== 1 ||
    result.status !== "failed" ||
    !errors.some((error) => error?.message?.includes(marker))
  )
    throw new Error("Broken metadata flow did not fail at the metadata assertion");
}

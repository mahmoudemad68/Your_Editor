/** Additive authenticated companion response; no MediaAnalysis version is changed. */
export const ANALYSIS_FAILURES = Object.freeze({
  authorization_failed: {
    code: "unavailable",
    message: "Analysis could not be published because authorization failed. Contact support.",
    retryable: false,
  },
  authorization_revoked: {
    code: "unavailable",
    message: "Analysis authorization is no longer valid. An editor can start a new analysis.",
    retryable: false,
  },
  publication_fenced: {
    code: "unavailable",
    message: "This analysis result is no longer current. Refresh the analysis.",
    retryable: false,
  },
  untrustworthy_alignment: {
    code: "unsupported",
    message:
      "Trustworthy word timing could not be established with the selected model. Choose a qualified model explicitly.",
    retryable: false,
  },
  analyzer_unavailable: {
    code: "unavailable",
    message: "The analyzer is unavailable. Try again later.",
    retryable: true,
  },
  cancelled: { code: "unavailable", message: "Analysis was cancelled.", retryable: false },
  timeout: {
    code: "timeout",
    message: "Analysis reached its time limit. Retry only on a qualified runtime.",
    retryable: false,
  },
  invalid_input: {
    code: "invalid_input",
    message: "The analysis input is invalid. Check the media and try again.",
    retryable: false,
  },
  internal: {
    code: "internal",
    message: "Analysis failed unexpectedly. Try again or contact support.",
    retryable: false,
  },
} as const);
export type AnalysisFailureCategory = keyof typeof ANALYSIS_FAILURES;
export function failureDetail(category: unknown) {
  const key: AnalysisFailureCategory =
    typeof category === "string" && Object.hasOwn(ANALYSIS_FAILURES, category)
      ? (category as AnalysisFailureCategory)
      : "internal";
  return { category: key, ...ANALYSIS_FAILURES[key] };
}
export type AnalysisFailureDetails = {
  mediaAssetId: string;
  sourceSha256: string;
  failures: ({ analyzer: "audio" | "speech" | "transcript"; retryable: boolean } & Omit<
    ReturnType<typeof failureDetail>,
    "retryable"
  >)[];
};
export function parseAnalysisFailureDetails(raw: unknown): AnalysisFailureDetails {
  if (typeof raw !== "object" || raw === null) throw new Error("Invalid analysis failure details.");
  const value = raw as Record<string, unknown>;
  if (
    typeof value["mediaAssetId"] !== "string" ||
    !/^[a-f0-9-]{36}$/.test(value["mediaAssetId"]) ||
    typeof value["sourceSha256"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(value["sourceSha256"]) ||
    !Array.isArray(value["failures"]) ||
    value["failures"].length > 3
  )
    throw new Error("Invalid analysis failure details.");
  const seen = new Set<string>();
  const failures = value["failures"].map(
    (item: unknown): AnalysisFailureDetails["failures"][number] => {
      if (typeof item !== "object" || item === null)
        throw new Error("Invalid analysis failure details.");
      const entry = item as Record<string, unknown>,
        analyzer = entry["analyzer"];
      if (
        (analyzer !== "audio" && analyzer !== "speech" && analyzer !== "transcript") ||
        seen.has(analyzer)
      )
        throw new Error("Invalid analysis failure details.");
      seen.add(analyzer);
      // Reconstruct from the allowlist; no upstream message or unknown property escapes.
      const detail = failureDetail(entry["category"]);
      return { analyzer, ...detail, retryable: detail.retryable && entry["retryable"] === true };
    },
  );
  return { mediaAssetId: value["mediaAssetId"], sourceSha256: value["sourceSha256"], failures };
}

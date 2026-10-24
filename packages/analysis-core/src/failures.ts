import type { AnalysisSection } from "./contracts.js";
import { failureDetail, type AnalysisFailureCategory } from "@editagent/schemas";
export { ANALYSIS_FAILURES, failureDetail, type AnalysisFailureCategory } from "@editagent/schemas";
export class AnalysisAdmissionError extends Error {
  constructor(readonly category: "authorization_revoked" | "publication_fenced") {
    super(failureDetail(category).message);
  }
}
/** Compatibility projection: frozen MediaAnalysis 1.0/1.1 documents keep five codes. */
export function legacyAnalysisFailure(
  category: AnalysisFailureCategory,
  retryable?: boolean,
): Extract<AnalysisSection, { status: "failed" }>["failure"] {
  const detail = failureDetail(category);
  const reasons = {
    invalid_input: "Analysis input is invalid.",
    unsupported: "This analysis is unsupported.",
    timeout: "Analysis timed out.",
    unavailable: "Analyzer is unavailable.",
    internal: "Analysis failed.",
  } as const;
  return {
    code: detail.code,
    reason: reasons[detail.code],
    retryable: retryable ?? detail.retryable,
  };
}

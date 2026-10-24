import {
  parseMediaAnalysis,
  validateMediaAnalysisV1_1,
  type MediaAnalysisV1_1,
} from "@editagent/schemas";
import type { AnalysisFailureDetails } from "@editagent/schemas";
export type { AnalysisFailureDetails } from "@editagent/schemas";

export const ANALYSIS_VERSION = "us210-v1";
export const ANALYSIS_QUEUE = "media-analysis-v1";
export type Analyzer = "transcript" | "audio" | "speech";
export type AnalysisDocument = ReturnType<typeof parseMediaAnalysis>;
export type AnalysisSection = MediaAnalysisV1_1["sections"]["transcript" | "audio"];

export interface AnalysisReader {
  failureDetails?(
    assetId: string,
    projectId: string,
    sourceSha256: string,
  ): Promise<AnalysisFailureDetails>;
  read(assetId: string, projectId: string, sourceSha256: string): Promise<AnalysisDocument | null>;
  retry?(
    assetId: string,
    projectId: string,
    analyzer: Analyzer,
    previousJobId: string,
    actorId?: string,
  ): Promise<string>;
}

/** Only produced sections change; unsupported analyzers never acquire invented data. */
export function withSection(
  document: MediaAnalysisV1_1,
  analyzer: Analyzer,
  section: AnalysisSection,
): MediaAnalysisV1_1 {
  return validateMediaAnalysisV1_1({
    ...document,
    sections: { ...document.sections, [analyzer === "speech" ? "audio" : analyzer]: section },
  });
}

/** Preparatory safety contract for downstream consumers, not an automated editor. */
export function assertOutsideProtectedWords(
  document: AnalysisDocument,
  ranges: readonly { startUs: string; endUs: string }[],
): void {
  const validated = parseMediaAnalysis(document);
  if (validated.sections.transcript.status !== "completed")
    throw new Error("Trustworthy word boundaries are unavailable.");
  const words = validated.sections.transcript.data.segments.flatMap((s) => s.words);
  for (const range of ranges) {
    if (!/^(0|[1-9][0-9]*)$/.test(range.startUs) || !/^(0|[1-9][0-9]*)$/.test(range.endUs))
      throw new Error("Invalid proposed range.");
    const start = BigInt(range.startUs),
      end = BigInt(range.endUs);
    if (
      start >= end ||
      validated.source.durationUs === undefined ||
      end > BigInt(validated.source.durationUs)
    )
      throw new Error("Invalid proposed range.");
    if (words.some((w) => start < BigInt(w.endUs) && end > BigInt(w.startUs)))
      throw new Error("Proposed range intersects protected transcript words.");
  }
}

import { MediaAnalysisSchema } from "./media-analysis.generated.js";
import { MediaAnalysisSchema as MediaAnalysisV1_1Schema } from "./media-analysis-v1_1.generated.js";

/** Persisted versions are exact contracts, never a best-effort latest-version fallback. */
export const validateMediaAnalysisV1 = (document: unknown) => MediaAnalysisSchema.parse(document);
export const validateMediaAnalysisV1_1 = (document: unknown) =>
  MediaAnalysisV1_1Schema.parse(document);

export function parseMediaAnalysis(document: unknown) {
  if (
    typeof document !== "object" ||
    document === null ||
    Array.isArray(document) ||
    !Object.hasOwn(document, "schemaVersion")
  )
    throw new Error("Missing MediaAnalysis version.");
  const version = (document as { schemaVersion: unknown }).schemaVersion;
  if (version === "1.0.0") return validateMediaAnalysisV1(document);
  if (version === "1.1.0") return validateMediaAnalysisV1_1(document);
  throw new Error("Unsupported MediaAnalysis version.");
}

/** Both parsers create boundary values; caller input is never mutated or supplemented. */
export function migrateMediaAnalysisV1ToV1_1(document: unknown) {
  const validated = validateMediaAnalysisV1(document);
  return validateMediaAnalysisV1_1({ ...validated, schemaVersion: "1.1.0" });
}

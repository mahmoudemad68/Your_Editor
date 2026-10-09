import { contentSha256, validateDocument } from "./validate.mjs";

// Input adapter only: no ASR, VAD, token normalization or fabricated gold.
export function scopedMetricInputs(type, gold, source, predictions) {
  if (!["word_alignment", "silence_labels"].includes(type))
    throw new Error("Unsupported scoped metric");
  validateDocument(type, gold, source, gold.datasetVersion);
  if (
    gold.createdBy !== "human" ||
    gold.review.status !== "approved" ||
    gold.review.evidence?.humanAttestation !== true ||
    gold.review.evidence.decision !== "approved" ||
    gold.review.evidence.reviewedContentSha256 !== contentSha256(gold) ||
    Number.isNaN(Date.parse(gold.review.evidence.reviewedAt))
  )
    throw new Error("Scoped metrics require current approved human gold");
  const lower = BigInt(gold.scope.startUs),
    upper = BigInt(gold.scope.endUs);
  const clipped = [];
  let previous = 0n;
  for (const prediction of predictions) {
    if (
      typeof prediction.startUs !== "string" ||
      typeof prediction.endUs !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(prediction.startUs) ||
      !/^(0|[1-9][0-9]*)$/.test(prediction.endUs)
    )
      throw new Error("Prediction timestamps must be decimal microsecond strings");
    const start = BigInt(prediction.startUs),
      end = BigInt(prediction.endUs);
    if (start >= end || start < previous || end > BigInt(source.durationUs))
      throw new Error("Prediction ranges must be ordered, nonoverlapping and inside source");
    previous = end;
    // Word inclusion uses its midpoint in the half-open scope; silence uses intersection.
    if (type === "word_alignment" && (start + end < 2n * lower || start + end >= 2n * upper))
      continue;
    const a = start < lower ? lower : start,
      b = end > upper ? upper : end;
    if (a < b) clipped.push({ ...prediction, startUs: String(a), endUs: String(b) });
  }
  return {
    scope: gold.scope,
    durationUs: String(upper - lower),
    gold: type === "word_alignment" ? gold.words : gold.intervals,
    predictions: clipped,
  };
}

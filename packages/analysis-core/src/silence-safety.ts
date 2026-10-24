import { frameRate, frameTime, snapToFrame, type FrameRate } from "@editagent/domain";
import { parseMediaAnalysis } from "@editagent/schemas";
import { type AnalysisDocument } from "./contracts.js";

export const SILENCE_REMOVAL_QUALIFICATION = "NOT_MET" as const;
export const SILENCE_WORD_PADDING_US = 50000n;

/** Preparatory rejection boundary only. No cut planning, editing or qualification override. */
export function assertSafeAutomaticSilenceRemoval(
  document: AnalysisDocument,
  ranges: readonly { startUs: string; endUs: string }[],
  rate: FrameRate,
): void {
  const validated = parseMediaAnalysis(document);
  const fps = frameRate(rate.numerator, rate.denominator);
  if (
    fps.numerator > 9223372036854775807n ||
    fps.denominator > 9223372036854775807n ||
    fps.numerator > 240n * fps.denominator ||
    frameTime(1n, fps) < 1n
  )
    throw new Error("Unsupported silence-removal frame grid.");
  if (!Array.isArray(ranges) || ranges.length > 56250)
    throw new Error("Invalid proposed silence range list.");
  if (!ranges.length) return; // A no-op removes no source content.
  if (
    validated.sections.audio.status !== "completed" ||
    validated.sections.audio.provenance.analyzer !== "ffmpeg-audio" ||
    validated.sections.audio.provenance.analyzerVersion !== "us204-v1" ||
    !validated.sections.audio.data.silence
  )
    throw new Error("Acoustic-silence evidence is unavailable; NON_SPEECH is insufficient.");
  const audio = validated.sections.audio.data;
  const transcript = validated.sections.transcript;
  if (transcript.status !== "completed") throw new Error("Trustworthy transcript is unavailable.");
  const protectedRanges = [
    ...transcript.data.segments.flatMap((s) => s.words),
    ...(audio.speech?.speechRegions ?? []),
  ]
    .map((w) => ({
      start: BigInt(w.startUs) - SILENCE_WORD_PADDING_US,
      end: BigInt(w.endUs) + SILENCE_WORD_PADDING_US,
    }))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  let previous = 0n;
  let silenceCursor = 0,
    protectedCursor = 0;
  for (const range of ranges) {
    if (
      typeof range.startUs !== "string" ||
      typeof range.endUs !== "string" ||
      !/^(0|[1-9][0-9]{0,19})$(?![\s\S])/.test(range.startUs) ||
      !/^(0|[1-9][0-9]{0,19})$(?![\s\S])/.test(range.endUs)
    )
      throw new Error("Invalid proposed silence range.");
    const start = BigInt(range.startUs),
      end = BigInt(range.endUs);
    if (
      start >= end ||
      !validated.source.durationUs ||
      end > BigInt(validated.source.durationUs) ||
      start < previous ||
      snapToFrame(start, fps) !== start ||
      snapToFrame(end, fps) !== end
    )
      throw new Error("Silence cuts require ordered exact source-frame boundaries.");
    previous = end;
    while (audio.silence?.[silenceCursor] && BigInt(audio.silence[silenceCursor]!.endUs) <= start)
      silenceCursor++;
    const silence = audio.silence?.[silenceCursor];
    if (!silence || start < BigInt(silence.startUs) || end > BigInt(silence.endUs))
      throw new Error("Proposed range is not contained in acoustic-silence evidence.");
    while (protectedRanges[protectedCursor] && protectedRanges[protectedCursor]!.end <= start)
      protectedCursor++;
    if (protectedRanges[protectedCursor] && protectedRanges[protectedCursor]!.start < end)
      throw new Error("Proposed range intersects padded speech or transcript words.");
  }
  // Thresholded amplitude has no calibrated content confidence. In particular,
  // subthreshold music/quiet speech can also satisfy silencedetect. Do not edit it.
  throw new Error("CP2_NOT_MET: automatic acoustic-silence removal is unqualified.");
}

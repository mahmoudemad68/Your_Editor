/** GENERATED FILE — DO NOT EDIT.
 * Canonical sources: packages/schemas/src/{media,analysis,speech}*.schema.json
 * Generator: tools/schema/generate-media-analysis.mjs v1.0.0; pnpm schemas:generate
 * Source SHA-256: a1da9b144fe882c7a068c34991fae36c74c2ac27d3769435e9b265348527291b */
import { z } from "zod";
import { checkRules, codePointLength, wellFormed } from "./analysis-validation.js";
export const MediaTimeSchema = z
  .string()
  .refine(wellFormed)
  .regex(new RegExp("^(0|[1-9][0-9]*)$", "u"));
export type MediaTime = z.infer<typeof MediaTimeSchema>;

export const TimeSchema = z
  .string()
  .refine(wellFormed)
  .refine((value) => codePointLength(value) >= 1)
  .refine((value) => codePointLength(value) <= 20)
  .regex(new RegExp("^(0|[1-9][0-9]*)$", "u"))
  .regex(new RegExp("^(0|[1-9][0-9]*)$(?![\\s\\S])", "u"));
export type Time = z.infer<typeof TimeSchema>;

export const TimeRangeSchema = z
  .strictObject({ startUs: TimeSchema, endUs: TimeSchema })
  .refine(
    (value) =>
      checkRules(value, [{ kind: "less", left: "startUs", right: "endUs", decimal: true }]),
    "Canonical schema relational constraint failed",
  );
export type TimeRange = z.infer<typeof TimeRangeSchema>;

export const AnalysisCommonSchema = z.strictObject({ range: TimeRangeSchema });
export type AnalysisCommon = z.infer<typeof AnalysisCommonSchema>;

export const ConfidenceSchema = z.number().finite().min(0).max(1);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const LogicalIdSchema = z
  .string()
  .refine(wellFormed)
  .refine((value) => codePointLength(value) >= 1)
  .refine((value) => codePointLength(value) <= 128)
  .regex(new RegExp("^[a-zA-Z0-9][a-zA-Z0-9._+-]*$(?![\\s\\S])", "u"));
export type LogicalId = z.infer<typeof LogicalIdSchema>;

export const Sha256Schema = z
  .string()
  .refine(wellFormed)
  .refine((value) => codePointLength(value) >= 64)
  .refine((value) => codePointLength(value) <= 64)
  .regex(new RegExp("^[0-9a-f]{64}$(?![\\s\\S])", "u"));
export type Sha256 = z.infer<typeof Sha256Schema>;

export const UuidV7Schema = z
  .string()
  .refine(wellFormed)
  .refine((value) => codePointLength(value) >= 36)
  .refine((value) => codePointLength(value) <= 36)
  .regex(
    new RegExp(
      "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\\s\\S])",
      "u",
    ),
  );
export type UuidV7 = z.infer<typeof UuidV7Schema>;

export const BoundingBoxSchema = z
  .strictObject({
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().max(1).gt(0),
    height: z.number().finite().max(1).gt(0),
  })
  .refine(
    (value) =>
      checkRules(value, [
        { kind: "sumMax", fields: ["x", "width"], maximum: 1 },
        { kind: "sumMax", fields: ["y", "height"], maximum: 1 },
      ]),
    "Canonical schema relational constraint failed",
  );
export type BoundingBox = z.infer<typeof BoundingBoxSchema>;

export const FailureSchema = z.strictObject({
  code: z.union([
    z.literal("invalid_input"),
    z.literal("unsupported"),
    z.literal("timeout"),
    z.literal("unavailable"),
    z.literal("internal"),
  ]),
  reason: z.union([
    z.literal("Analysis input is invalid."),
    z.literal("This analysis is unsupported."),
    z.literal("Analysis timed out."),
    z.literal("Analyzer is unavailable."),
    z.literal("Analysis failed."),
  ]),
  retryable: z.boolean(),
});
export type Failure = z.infer<typeof FailureSchema>;

export const ModelIdentitySchema = z.strictObject({
  name: z
    .string()
    .refine(wellFormed)
    .refine((value) => codePointLength(value) >= 1)
    .refine((value) => codePointLength(value) <= 128)
    .regex(new RegExp("^[a-zA-Z0-9][a-zA-Z0-9._+-]*$(?![\\s\\S])", "u")),
  version: z
    .string()
    .refine(wellFormed)
    .refine((value) => codePointLength(value) >= 1)
    .refine((value) => codePointLength(value) <= 128)
    .regex(new RegExp("^[a-zA-Z0-9][a-zA-Z0-9._+-]*$(?![\\s\\S])", "u")),
  sha256: z
    .string()
    .refine(wellFormed)
    .refine((value) => codePointLength(value) >= 64)
    .refine((value) => codePointLength(value) <= 64)
    .regex(new RegExp("^[0-9a-f]{64}$(?![\\s\\S])", "u")),
});
export type ModelIdentity = z.infer<typeof ModelIdentitySchema>;

export const AnalyzerProvenanceSchema = z.strictObject({
  analyzer: z
    .string()
    .refine(wellFormed)
    .refine((value) => codePointLength(value) >= 1)
    .refine((value) => codePointLength(value) <= 128)
    .regex(new RegExp("^[a-zA-Z0-9][a-zA-Z0-9._+-]*$(?![\\s\\S])", "u")),
  analyzerVersion: z
    .string()
    .refine(wellFormed)
    .refine((value) => codePointLength(value) >= 1)
    .refine((value) => codePointLength(value) <= 128)
    .regex(new RegExp("^[a-zA-Z0-9][a-zA-Z0-9._+-]*$(?![\\s\\S])", "u")),
  sourceSha256: z
    .string()
    .refine(wellFormed)
    .refine((value) => codePointLength(value) >= 64)
    .refine((value) => codePointLength(value) <= 64)
    .regex(new RegExp("^[0-9a-f]{64}$(?![\\s\\S])", "u")),
  configurationSha256: z
    .string()
    .refine(wellFormed)
    .refine((value) => codePointLength(value) >= 64)
    .refine((value) => codePointLength(value) <= 64)
    .regex(new RegExp("^[0-9a-f]{64}$(?![\\s\\S])", "u")),
  inputArtifactId: z
    .string()
    .refine(wellFormed)
    .refine((value) => codePointLength(value) >= 1)
    .refine((value) => codePointLength(value) <= 128)
    .regex(new RegExp("^[a-zA-Z0-9][a-zA-Z0-9._+-]*$(?![\\s\\S])", "u"))
    .optional(),
  inputSha256: z
    .string()
    .refine(wellFormed)
    .refine((value) => codePointLength(value) >= 64)
    .refine((value) => codePointLength(value) <= 64)
    .regex(new RegExp("^[0-9a-f]{64}$(?![\\s\\S])", "u"))
    .optional(),
  runtime: z
    .string()
    .refine(wellFormed)
    .refine((value) => codePointLength(value) >= 1)
    .refine((value) => codePointLength(value) <= 128)
    .regex(new RegExp("^[a-zA-Z0-9][a-zA-Z0-9._+-]*$(?![\\s\\S])", "u"))
    .optional(),
  runtimeVersion: z
    .string()
    .refine(wellFormed)
    .refine((value) => codePointLength(value) >= 1)
    .refine((value) => codePointLength(value) <= 128)
    .regex(new RegExp("^[a-zA-Z0-9][a-zA-Z0-9._+-]*$(?![\\s\\S])", "u"))
    .optional(),
  model: ModelIdentitySchema.optional(),
});
export type AnalyzerProvenance = z.infer<typeof AnalyzerProvenanceSchema>;

export const FrameRateSchema = z
  .strictObject({ numerator: TimeSchema, denominator: TimeSchema })
  .refine(
    (value) =>
      checkRules(value, [
        { kind: "positive", field: "numerator", decimal: true },
        { kind: "positive", field: "denominator", decimal: true },
        { kind: "maximum", field: "numerator", value: "9223372036854775807", decimal: true },
        { kind: "maximum", field: "denominator", value: "9223372036854775807", decimal: true },
      ]),
    "Canonical schema relational constraint failed",
  );
export type FrameRate = z.infer<typeof FrameRateSchema>;

export const MediaMetadataSchema = z
  .strictObject({
    kind: z.union([z.literal("video"), z.literal("audio"), z.literal("image")]),
    durationUs: TimeSchema.optional(),
    container: z
      .string()
      .refine(wellFormed)
      .refine((value) => codePointLength(value) >= 1)
      .refine((value) => codePointLength(value) <= 64)
      .regex(new RegExp("^[A-Za-z0-9][A-Za-z0-9._+-]*$(?![\\s\\S])", "u"))
      .optional(),
    videoCodec: z
      .string()
      .refine(wellFormed)
      .refine((value) => codePointLength(value) >= 1)
      .refine((value) => codePointLength(value) <= 64)
      .regex(new RegExp("^[A-Za-z0-9][A-Za-z0-9._+-]*$(?![\\s\\S])", "u"))
      .optional(),
    audioCodec: z
      .string()
      .refine(wellFormed)
      .refine((value) => codePointLength(value) >= 1)
      .refine((value) => codePointLength(value) <= 64)
      .regex(new RegExp("^[A-Za-z0-9][A-Za-z0-9._+-]*$(?![\\s\\S])", "u"))
      .optional(),
    width: z.number().finite().int().min(1).max(2147483647).optional(),
    height: z.number().finite().int().min(1).max(2147483647).optional(),
    displayWidth: z.number().finite().int().min(1).max(2147483647).optional(),
    displayHeight: z.number().finite().int().min(1).max(2147483647).optional(),
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
    frameRate: FrameRateSchema.optional(),
    frameRateMode: z
      .union([z.literal("constant"), z.literal("variable"), z.literal("unknown")])
      .optional(),
    colorSpace: z
      .string()
      .refine(wellFormed)
      .refine((value) => codePointLength(value) >= 1)
      .refine((value) => codePointLength(value) <= 64)
      .regex(new RegExp("^[A-Za-z0-9][A-Za-z0-9._+-]*$(?![\\s\\S])", "u"))
      .optional(),
    audioChannels: z.number().finite().int().min(1).max(64).optional(),
    sampleRate: z.number().finite().int().min(1).max(1000000).optional(),
  })
  .refine(
    (value) =>
      checkRules(value, [
        { kind: "together", fields: ["width", "height", "displayWidth", "displayHeight"] },
        {
          kind: "rotatedDimensions",
          width: "width",
          height: "height",
          displayWidth: "displayWidth",
          displayHeight: "displayHeight",
          rotation: "rotation",
        },
      ]),
    "Canonical schema relational constraint failed",
  );
export type MediaMetadata = z.infer<typeof MediaMetadataSchema>;

export const TranscriptWordSchema = z
  .strictObject({
    text: z
      .string()
      .refine(wellFormed)
      .refine((value) => codePointLength(value) >= 1)
      .refine((value) => codePointLength(value) <= 256)
      .regex(new RegExp("^[^\\ud800-\\udfff]*$(?![\\s\\S])", "u")),
    startUs: TimeSchema,
    endUs: TimeSchema,
    confidence: z.number().finite().min(0).max(1).optional(),
    speaker: z
      .string()
      .refine(wellFormed)
      .refine((value) => codePointLength(value) >= 1)
      .refine((value) => codePointLength(value) <= 128)
      .regex(new RegExp("^[a-zA-Z0-9][a-zA-Z0-9._+-]*$(?![\\s\\S])", "u"))
      .optional(),
  })
  .refine(
    (value) =>
      checkRules(value, [{ kind: "less", left: "startUs", right: "endUs", decimal: true }]),
    "Canonical schema relational constraint failed",
  );
export type TranscriptWord = z.infer<typeof TranscriptWordSchema>;

export const TranscriptSegmentSchema = z
  .strictObject({
    id: LogicalIdSchema,
    text: z
      .string()
      .refine(wellFormed)
      .refine((value) => codePointLength(value) >= 1)
      .refine((value) => codePointLength(value) <= 16384)
      .regex(new RegExp("^[^\\ud800-\\udfff]*$(?![\\s\\S])", "u")),
    startUs: TimeSchema,
    endUs: TimeSchema,
    confidence: z.number().finite().min(0).max(1).optional(),
    words: z.array(TranscriptWordSchema).min(0).max(54000),
  })
  .refine(
    (value) =>
      checkRules(value, [
        { kind: "less", left: "startUs", right: "endUs", decimal: true },
        { kind: "orderedRanges", field: "words", start: "startUs", end: "endUs" },
        {
          kind: "rangesWithin",
          field: "words",
          lower: "startUs",
          upper: "endUs",
          start: "startUs",
          end: "endUs",
        },
      ]),
    "Canonical schema relational constraint failed",
  );
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const TranscriptSchema = z
  .strictObject({
    language: z
      .string()
      .refine(wellFormed)
      .refine((value) => codePointLength(value) >= 2)
      .refine((value) => codePointLength(value) <= 35)
      .regex(new RegExp("^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$(?![\\s\\S])", "u")),
    languageConfidence: z.number().finite().min(0).max(1).optional(),
    segments: z.array(TranscriptSegmentSchema).min(0).max(54000),
  })
  .refine(
    (value) =>
      checkRules(value, [
        { kind: "orderedRanges", field: "segments", start: "startUs", end: "endUs" },
        { kind: "unique", field: "segments", key: "id" },
        { kind: "nestedCount", field: "segments", child: "words", maximum: 54000 },
      ]),
    "Canonical schema relational constraint failed",
  );
export type Transcript = z.infer<typeof TranscriptSchema>;

export const SpeechAnalysisSourceSchema = z
  .strictObject({
    sourceId: z
      .string()
      .refine(wellFormed)
      .refine((value) => codePointLength(value) >= 1)
      .refine((value) => codePointLength(value) <= 128)
      .regex(new RegExp("^[a-zA-Z0-9][a-zA-Z0-9._-]*$(?![\\s\\S])", "u")),
    sourceSha256: z
      .string()
      .refine(wellFormed)
      .regex(new RegExp("^[0-9a-f]{64}$(?![\\s\\S])", "u")),
    artifactId: z
      .string()
      .refine(wellFormed)
      .refine((value) => codePointLength(value) >= 1)
      .refine((value) => codePointLength(value) <= 128)
      .regex(new RegExp("^[a-zA-Z0-9][a-zA-Z0-9._-]*$(?![\\s\\S])", "u")),
    audioSha256: z.string().refine(wellFormed).regex(new RegExp("^[0-9a-f]{64}$(?![\\s\\S])", "u")),
    sourceDurationUs: z
      .string()
      .refine(wellFormed)
      .refine((value) => codePointLength(value) <= 10)
      .regex(new RegExp("^(0|[1-9][0-9]*)$(?![\\s\\S])", "u")),
    scopeStartUs: z
      .string()
      .refine(wellFormed)
      .refine((value) => codePointLength(value) <= 10)
      .regex(new RegExp("^(0|[1-9][0-9]*)$(?![\\s\\S])", "u")),
    scopeEndUs: z
      .string()
      .refine(wellFormed)
      .refine((value) => codePointLength(value) <= 10)
      .regex(new RegExp("^(0|[1-9][0-9]*)$(?![\\s\\S])", "u")),
  })
  .refine(
    (value) =>
      checkRules(value, [
        { kind: "positive", field: "sourceDurationUs", decimal: true },
        { kind: "maximum", field: "sourceDurationUs", value: "1800000000", decimal: true },
        { kind: "less", left: "scopeStartUs", right: "scopeEndUs", decimal: true },
        { kind: "lessEqual", left: "scopeEndUs", right: "sourceDurationUs", decimal: true },
      ]),
    "Canonical schema relational constraint failed",
  );
export type SpeechAnalysisSource = z.infer<typeof SpeechAnalysisSourceSchema>;

export const SpeechRegionSchema = z
  .strictObject({
    startUs: z
      .string()
      .refine(wellFormed)
      .refine((value) => codePointLength(value) <= 10)
      .regex(new RegExp("^(0|[1-9][0-9]*)$(?![\\s\\S])", "u")),
    endUs: z
      .string()
      .refine(wellFormed)
      .refine((value) => codePointLength(value) <= 10)
      .regex(new RegExp("^(0|[1-9][0-9]*)$(?![\\s\\S])", "u")),
    confidence: z.number().finite().min(0).max(1),
  })
  .refine(
    (value) =>
      checkRules(value, [{ kind: "less", left: "startUs", right: "endUs", decimal: true }]),
    "Canonical schema relational constraint failed",
  );
export type SpeechRegion = z.infer<typeof SpeechRegionSchema>;

export const SpeechAnalysisProvenanceConfigurationSchema = z
  .strictObject({
    speechThreshold: z.number().finite().gt(0).lt(1),
    negativeThreshold: z.number().finite().gt(0).lt(1),
    minSpeechUs: z
      .string()
      .refine(wellFormed)
      .refine((value) => codePointLength(value) <= 10)
      .regex(new RegExp("^(0|[1-9][0-9]*)$(?![\\s\\S])", "u")),
    minSilenceUs: z
      .string()
      .refine(wellFormed)
      .refine((value) => codePointLength(value) <= 10)
      .regex(new RegExp("^(0|[1-9][0-9]*)$(?![\\s\\S])", "u")),
    paddingUs: z
      .string()
      .refine(wellFormed)
      .refine((value) => codePointLength(value) <= 10)
      .regex(new RegExp("^(0|[1-9][0-9]*)$(?![\\s\\S])", "u")),
  })
  .refine(
    (value) =>
      checkRules(value, [
        { kind: "less", left: "negativeThreshold", right: "speechThreshold", decimal: false },
        { kind: "positive", field: "minSpeechUs", decimal: true },
        { kind: "positive", field: "minSilenceUs", decimal: true },
        { kind: "maximum", field: "minSpeechUs", value: "1800000000", decimal: true },
        { kind: "maximum", field: "minSilenceUs", value: "1800000000", decimal: true },
        { kind: "maximum", field: "paddingUs", value: "1000000", decimal: true },
      ]),
    "Canonical schema relational constraint failed",
  );
export type SpeechAnalysisProvenanceConfiguration = z.infer<
  typeof SpeechAnalysisProvenanceConfigurationSchema
>;

export const SpeechAnalysisProvenanceSchema = z.strictObject({
  adapterVersion: z.literal("silero-onnx-stream-v1"),
  modelName: z.literal("silero-vad"),
  modelVersion: z.literal("v6-faster-whisper-1.2.1"),
  modelSha256: z.literal("4cbf549b8326f60f80f2536d9eefeb450a9abe83365a098031c89719f1be17d2"),
  runtime: z.literal("onnxruntime"),
  runtimeVersion: z
    .string()
    .refine(wellFormed)
    .refine((value) => codePointLength(value) >= 1)
    .refine((value) => codePointLength(value) <= 32)
    .regex(new RegExp("^[a-zA-Z0-9][a-zA-Z0-9._-]*$(?![\\s\\S])", "u")),
  numpyVersion: z
    .string()
    .refine(wellFormed)
    .refine((value) => codePointLength(value) >= 1)
    .refine((value) => codePointLength(value) <= 32)
    .regex(new RegExp("^[a-zA-Z0-9][a-zA-Z0-9._-]*$(?![\\s\\S])", "u")),
  normalizedPcmSha256: z
    .string()
    .refine(wellFormed)
    .regex(new RegExp("^[0-9a-f]{64}$(?![\\s\\S])", "u")),
  configuration: SpeechAnalysisProvenanceConfigurationSchema,
  sampleRate: z.literal(16000),
  windowSamples: z.literal(512),
  contextSamples: z.literal(64),
  threads: z.literal(1),
  device: z.literal("cpu"),
  confidenceAggregation: z.literal("sample_weighted_mean_in_padded_region"),
});
export type SpeechAnalysisProvenance = z.infer<typeof SpeechAnalysisProvenanceSchema>;

export const SpeechAnalysisSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    source: SpeechAnalysisSourceSchema,
    speechRegions: z.array(SpeechRegionSchema).max(56250),
    provenance: SpeechAnalysisProvenanceSchema,
  })
  .refine(
    (value) =>
      checkRules(value, [
        { kind: "orderedRanges", field: "speechRegions", start: "startUs", end: "endUs" },
        {
          kind: "rangesWithin",
          field: "speechRegions",
          lower: "source.scopeStartUs",
          upper: "source.scopeEndUs",
          start: "startUs",
          end: "endUs",
        },
      ]),
    "Canonical schema relational constraint failed",
  );
export type SpeechAnalysis = z.infer<typeof SpeechAnalysisSchema>;

export const LoudnessSchema = z
  .strictObject({
    integratedLufs: z.number().finite().min(-200).max(100).optional(),
    truePeakDbtp: z.number().finite().min(-200).max(100).optional(),
    loudnessRangeLu: z.number().finite().min(0).max(200).optional(),
  })
  .refine((value) => Object.keys(value).length >= 1);
export type Loudness = z.infer<typeof LoudnessSchema>;

export const EnergyPointSchema = z.strictObject({
  atUs: TimeSchema,
  rmsDbfs: z.number().finite().min(-200).max(0),
});
export type EnergyPoint = z.infer<typeof EnergyPointSchema>;

export const WaveformPeakSchema = z
  .strictObject({
    atUs: TimeSchema,
    minimum: z.number().finite().min(-1).max(1),
    maximum: z.number().finite().min(-1).max(1),
  })
  .refine(
    (value) =>
      checkRules(value, [{ kind: "lessEqual", left: "minimum", right: "maximum", decimal: false }]),
    "Canonical schema relational constraint failed",
  );
export type WaveformPeak = z.infer<typeof WaveformPeakSchema>;

export const AudioAnalysisSchema = z
  .strictObject({
    speech: SpeechAnalysisSchema.optional(),
    silence: z.array(TimeRangeSchema).min(0).max(56250).optional(),
    loudness: LoudnessSchema.optional(),
    energyCurve: z.array(EnergyPointSchema).min(0).max(108000).optional(),
    waveformPeaks: z.array(WaveformPeakSchema).min(0).max(108000).optional(),
  })
  .refine((value) => Object.keys(value).length >= 1)
  .refine(
    (value) =>
      checkRules(value, [
        { kind: "orderedRanges", field: "silence", start: "startUs", end: "endUs" },
        { kind: "orderedPoints", field: "energyCurve", time: "atUs" },
        { kind: "orderedPoints", field: "waveformPeaks", time: "atUs" },
      ]),
    "Canonical schema relational constraint failed",
  );
export type AudioAnalysis = z.infer<typeof AudioAnalysisSchema>;

export const SceneSchema = z
  .strictObject({
    id: LogicalIdSchema,
    startUs: TimeSchema,
    endUs: TimeSchema,
    confidence: z.number().finite().min(0).max(1),
  })
  .refine(
    (value) =>
      checkRules(value, [{ kind: "less", left: "startUs", right: "endUs", decimal: true }]),
    "Canonical schema relational constraint failed",
  );
export type Scene = z.infer<typeof SceneSchema>;

export const SceneAnalysisSchema = z
  .strictObject({ scenes: z.array(SceneSchema).min(0).max(108000) })
  .refine(
    (value) =>
      checkRules(value, [
        { kind: "orderedRanges", field: "scenes", start: "startUs", end: "endUs" },
        { kind: "unique", field: "scenes", key: "id" },
      ]),
    "Canonical schema relational constraint failed",
  );
export type SceneAnalysis = z.infer<typeof SceneAnalysisSchema>;

export const FaceObservationSchema = z.strictObject({
  atUs: TimeSchema,
  boundingBox: BoundingBoxSchema,
  confidence: z.number().finite().min(0).max(1),
});
export type FaceObservation = z.infer<typeof FaceObservationSchema>;

export const FaceTrackSchema = z
  .strictObject({
    id: LogicalIdSchema,
    startUs: TimeSchema,
    endUs: TimeSchema,
    observations: z.array(FaceObservationSchema).min(1).max(108000),
  })
  .refine(
    (value) =>
      checkRules(value, [
        { kind: "less", left: "startUs", right: "endUs", decimal: true },
        { kind: "orderedPoints", field: "observations", time: "atUs" },
        {
          kind: "pointsWithin",
          field: "observations",
          lower: "startUs",
          upper: "endUs",
          time: "atUs",
        },
      ]),
    "Canonical schema relational constraint failed",
  );
export type FaceTrack = z.infer<typeof FaceTrackSchema>;

export const FaceAnalysisSchema = z
  .strictObject({ tracks: z.array(FaceTrackSchema).min(0).max(128) })
  .refine(
    (value) =>
      checkRules(value, [
        { kind: "unique", field: "tracks", key: "id" },
        { kind: "nestedCount", field: "tracks", child: "observations", maximum: 108000 },
      ]),
    "Canonical schema relational constraint failed",
  );
export type FaceAnalysis = z.infer<typeof FaceAnalysisSchema>;

export const ObjectObservationSchema = z.strictObject({
  atUs: TimeSchema,
  boundingBox: BoundingBoxSchema,
  confidence: z.number().finite().min(0).max(1),
});
export type ObjectObservation = z.infer<typeof ObjectObservationSchema>;

export const ObjectTrackSchema = z
  .strictObject({
    id: LogicalIdSchema,
    label: z
      .string()
      .refine(wellFormed)
      .refine((value) => codePointLength(value) >= 1)
      .refine((value) => codePointLength(value) <= 128)
      .regex(new RegExp("^[^\\ud800-\\udfff]*$(?![\\s\\S])", "u")),
    startUs: TimeSchema,
    endUs: TimeSchema,
    observations: z.array(ObjectObservationSchema).min(1).max(108000),
  })
  .refine(
    (value) =>
      checkRules(value, [
        { kind: "less", left: "startUs", right: "endUs", decimal: true },
        { kind: "orderedPoints", field: "observations", time: "atUs" },
        {
          kind: "pointsWithin",
          field: "observations",
          lower: "startUs",
          upper: "endUs",
          time: "atUs",
        },
      ]),
    "Canonical schema relational constraint failed",
  );
export type ObjectTrack = z.infer<typeof ObjectTrackSchema>;

export const ObjectAnalysisSchema = z
  .strictObject({ tracks: z.array(ObjectTrackSchema).min(0).max(1024) })
  .refine(
    (value) =>
      checkRules(value, [
        { kind: "unique", field: "tracks", key: "id" },
        { kind: "nestedCount", field: "tracks", child: "observations", maximum: 108000 },
      ]),
    "Canonical schema relational constraint failed",
  );
export type ObjectAnalysis = z.infer<typeof ObjectAnalysisSchema>;

export const MediaAnalysisSourceSchema = z
  .strictObject({
    sha256: z
      .string()
      .refine(wellFormed)
      .refine((value) => codePointLength(value) >= 64)
      .refine((value) => codePointLength(value) <= 64)
      .regex(new RegExp("^[0-9a-f]{64}$(?![\\s\\S])", "u")),
    durationUs: TimeSchema.optional(),
  })
  .refine(
    (value) => checkRules(value, [{ kind: "positive", field: "durationUs", decimal: true }]),
    "Canonical schema relational constraint failed",
  );
export type MediaAnalysisSource = z.infer<typeof MediaAnalysisSourceSchema>;

export const MediaAnalysisDocumentProvenanceSchema = z.strictObject({
  producer: z
    .string()
    .refine(wellFormed)
    .refine((value) => codePointLength(value) >= 1)
    .refine((value) => codePointLength(value) <= 128)
    .regex(new RegExp("^[a-zA-Z0-9][a-zA-Z0-9._+-]*$(?![\\s\\S])", "u")),
  producerVersion: z
    .string()
    .refine(wellFormed)
    .refine((value) => codePointLength(value) >= 1)
    .refine((value) => codePointLength(value) <= 128)
    .regex(new RegExp("^[a-zA-Z0-9][a-zA-Z0-9._+-]*$(?![\\s\\S])", "u")),
});
export type MediaAnalysisDocumentProvenance = z.infer<typeof MediaAnalysisDocumentProvenanceSchema>;

export const MetadataNotAvailableSchema = z.strictObject({ status: z.literal("not_available") });
export type MetadataNotAvailable = z.infer<typeof MetadataNotAvailableSchema>;

export const MetadataCompletedSchema = z.strictObject({
  status: z.literal("completed"),
  data: MediaMetadataSchema,
  provenance: AnalyzerProvenanceSchema,
});
export type MetadataCompleted = z.infer<typeof MetadataCompletedSchema>;

export const MetadataFailedSchema = z.strictObject({
  status: z.literal("failed"),
  failure: FailureSchema,
});
export type MetadataFailed = z.infer<typeof MetadataFailedSchema>;

export const MetadataSectionSchema = z.union([
  MetadataNotAvailableSchema,
  MetadataCompletedSchema,
  MetadataFailedSchema,
]);
export type MetadataSection = z.infer<typeof MetadataSectionSchema>;

export const TranscriptNotAvailableSchema = z.strictObject({ status: z.literal("not_available") });
export type TranscriptNotAvailable = z.infer<typeof TranscriptNotAvailableSchema>;

export const TranscriptCompletedSchema = z.strictObject({
  status: z.literal("completed"),
  data: TranscriptSchema,
  provenance: AnalyzerProvenanceSchema,
});
export type TranscriptCompleted = z.infer<typeof TranscriptCompletedSchema>;

export const TranscriptFailedSchema = z.strictObject({
  status: z.literal("failed"),
  failure: FailureSchema,
});
export type TranscriptFailed = z.infer<typeof TranscriptFailedSchema>;

export const TranscriptSectionSchema = z.union([
  TranscriptNotAvailableSchema,
  TranscriptCompletedSchema,
  TranscriptFailedSchema,
]);
export type TranscriptSection = z.infer<typeof TranscriptSectionSchema>;

export const AudioNotAvailableSchema = z.strictObject({ status: z.literal("not_available") });
export type AudioNotAvailable = z.infer<typeof AudioNotAvailableSchema>;

export const AudioCompletedSchema = z.strictObject({
  status: z.literal("completed"),
  data: AudioAnalysisSchema,
  provenance: AnalyzerProvenanceSchema,
});
export type AudioCompleted = z.infer<typeof AudioCompletedSchema>;

export const AudioFailedSchema = z.strictObject({
  status: z.literal("failed"),
  failure: FailureSchema,
});
export type AudioFailed = z.infer<typeof AudioFailedSchema>;

export const AudioSectionSchema = z.union([
  AudioNotAvailableSchema,
  AudioCompletedSchema,
  AudioFailedSchema,
]);
export type AudioSection = z.infer<typeof AudioSectionSchema>;

export const ScenesNotAvailableSchema = z.strictObject({ status: z.literal("not_available") });
export type ScenesNotAvailable = z.infer<typeof ScenesNotAvailableSchema>;

export const ScenesCompletedSchema = z.strictObject({
  status: z.literal("completed"),
  data: SceneAnalysisSchema,
  provenance: AnalyzerProvenanceSchema,
});
export type ScenesCompleted = z.infer<typeof ScenesCompletedSchema>;

export const ScenesFailedSchema = z.strictObject({
  status: z.literal("failed"),
  failure: FailureSchema,
});
export type ScenesFailed = z.infer<typeof ScenesFailedSchema>;

export const ScenesSectionSchema = z.union([
  ScenesNotAvailableSchema,
  ScenesCompletedSchema,
  ScenesFailedSchema,
]);
export type ScenesSection = z.infer<typeof ScenesSectionSchema>;

export const FacesNotAvailableSchema = z.strictObject({ status: z.literal("not_available") });
export type FacesNotAvailable = z.infer<typeof FacesNotAvailableSchema>;

export const FacesCompletedSchema = z.strictObject({
  status: z.literal("completed"),
  data: FaceAnalysisSchema,
  provenance: AnalyzerProvenanceSchema,
});
export type FacesCompleted = z.infer<typeof FacesCompletedSchema>;

export const FacesFailedSchema = z.strictObject({
  status: z.literal("failed"),
  failure: FailureSchema,
});
export type FacesFailed = z.infer<typeof FacesFailedSchema>;

export const FacesSectionSchema = z.union([
  FacesNotAvailableSchema,
  FacesCompletedSchema,
  FacesFailedSchema,
]);
export type FacesSection = z.infer<typeof FacesSectionSchema>;

export const ObjectsNotAvailableSchema = z.strictObject({ status: z.literal("not_available") });
export type ObjectsNotAvailable = z.infer<typeof ObjectsNotAvailableSchema>;

export const ObjectsCompletedSchema = z.strictObject({
  status: z.literal("completed"),
  data: ObjectAnalysisSchema,
  provenance: AnalyzerProvenanceSchema,
});
export type ObjectsCompleted = z.infer<typeof ObjectsCompletedSchema>;

export const ObjectsFailedSchema = z.strictObject({
  status: z.literal("failed"),
  failure: FailureSchema,
});
export type ObjectsFailed = z.infer<typeof ObjectsFailedSchema>;

export const ObjectsSectionSchema = z.union([
  ObjectsNotAvailableSchema,
  ObjectsCompletedSchema,
  ObjectsFailedSchema,
]);
export type ObjectsSection = z.infer<typeof ObjectsSectionSchema>;

export const MediaAnalysisSectionsSchema = z.strictObject({
  metadata: MetadataSectionSchema,
  transcript: TranscriptSectionSchema,
  audio: AudioSectionSchema,
  scenes: ScenesSectionSchema,
  faces: FacesSectionSchema,
  objects: ObjectsSectionSchema,
});
export type MediaAnalysisSections = z.infer<typeof MediaAnalysisSectionsSchema>;

export const MediaAnalysisSchema = z
  .strictObject({
    schemaVersion: z.literal("1.0.0"),
    mediaAssetId: UuidV7Schema,
    source: MediaAnalysisSourceSchema,
    provenance: MediaAnalysisDocumentProvenanceSchema,
    sections: MediaAnalysisSectionsSchema,
  })
  .refine(
    (value) =>
      checkRules(value, [
        {
          kind: "sameWhenPresent",
          left: "source.sha256",
          right: "sections.metadata.provenance.sourceSha256",
        },
        {
          kind: "sameWhenPresent",
          left: "source.sha256",
          right: "sections.transcript.provenance.sourceSha256",
        },
        {
          kind: "sameWhenPresent",
          left: "source.sha256",
          right: "sections.audio.provenance.sourceSha256",
        },
        {
          kind: "sameWhenPresent",
          left: "source.sha256",
          right: "sections.scenes.provenance.sourceSha256",
        },
        {
          kind: "sameWhenPresent",
          left: "source.sha256",
          right: "sections.faces.provenance.sourceSha256",
        },
        {
          kind: "sameWhenPresent",
          left: "source.sha256",
          right: "sections.objects.provenance.sourceSha256",
        },
        {
          kind: "sameWhenPresent",
          left: "source.durationUs",
          right: "sections.metadata.data.durationUs",
        },
        {
          kind: "sameWhenPresent",
          left: "source.sha256",
          right: "sections.audio.data.speech.source.sourceSha256",
        },
        {
          kind: "sameWhenPresent",
          left: "source.durationUs",
          right: "sections.audio.data.speech.source.sourceDurationUs",
        },
        {
          kind: "timesWithin",
          fields: [
            "sections.transcript.data",
            "sections.audio.data",
            "sections.scenes.data",
            "sections.faces.data",
            "sections.objects.data",
          ],
          duration: "source.durationUs",
          timeKeys: ["startUs", "endUs", "atUs", "scopeStartUs", "scopeEndUs"],
        },
      ]),
    "Canonical schema relational constraint failed",
  );
export type MediaAnalysis = z.infer<typeof MediaAnalysisSchema>;

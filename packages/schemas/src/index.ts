import jobEnvelopeSchema from "./job-envelope.schema.json";
import mediaTimeSchema from "./media-time.schema.json";
import workerHealthSchema from "./worker-health.schema.json";

export { jobEnvelopeSchema, mediaTimeSchema, workerHealthSchema };

export { default as jobEventSchema } from "./job-event.schema.json";

export type { JobEvent, JobProgressStage } from "./job-event.generated.js";

export { default as validateJobEvent } from "./job-event-validator.generated.js";

export { default as projectSchema } from "./project.schema.json";
export { default as editCommandSchema } from "./edit-command.schema.json";

export { default as speechAnalysisSchema } from "./speech-analysis.schema.json";

export { default as mediaAnalysisSchema } from "./media-analysis.schema.json";
export { default as mediaAnalysisV1_1Schema } from "./media-analysis-v1_1.schema.json";
export {
  MediaAnalysisSchema as MediaAnalysisV1_1Schema,
  AudioAnalysisSchema as AudioAnalysisV1_1Schema,
} from "./media-analysis-v1_1.generated.js";
export type {
  MediaAnalysis as MediaAnalysisV1_1,
  AudioAnalysis as AudioAnalysisV1_1,
} from "./media-analysis-v1_1.generated.js";
export {
  validateMediaAnalysisV1,
  validateMediaAnalysisV1_1,
  parseMediaAnalysis,
  migrateMediaAnalysisV1ToV1_1,
} from "./media-analysis-versions.js";
export {
  MediaAnalysisSchema,
  SpeechAnalysisSchema,
  TranscriptSchema,
  AudioAnalysisSchema,
  MediaMetadataSchema,
  SceneAnalysisSchema,
  FaceAnalysisSchema,
  ObjectAnalysisSchema,
  AnalyzerProvenanceSchema,
  TimeSchema as AnalysisTimeSchema,
} from "./media-analysis.generated.js";
export type {
  MediaAnalysis,
  SpeechAnalysis,
  Transcript,
  AudioAnalysis,
  MediaMetadata,
  SceneAnalysis,
  FaceAnalysis,
  ObjectAnalysis,
  AnalyzerProvenance,
  Time as AnalysisTime,
} from "./media-analysis.generated.js";

export { default as renderJobSchema } from "./render-job.schema.json";

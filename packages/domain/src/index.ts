export { DomainError } from "./kernel/error.js";
export { instant } from "./kernel/clock.js";
export type { Instant } from "./kernel/clock.js";
export {
  agentRunId,
  brandKitId,
  clipId,
  componentId,
  createUuidV7,
  creativeMemoryId,
  critiqueId,
  derivedAssetId,
  effectId,
  jobId,
  mediaAssetId,
  projectId,
  timelineId,
  toolId,
  trackId,
  userId,
  uuidV7,
} from "./kernel/id.js";
export type {
  AgentRunId,
  BrandKitId,
  ClipId,
  ComponentId,
  CreativeMemoryId,
  CritiqueId,
  DerivedAssetId,
  EffectId,
  JobId,
  MediaAssetId,
  ProjectId,
  TimelineId,
  ToolId,
  TrackId,
  UserId,
  UuidV7,
} from "./kernel/id.js";
export { frameIndex, frameRate, microseconds, frameTime, snapToFrame } from "./kernel/time.js";
export type { FrameIndex, FrameRate, Microseconds } from "./kernel/time.js";

export { AgentRun, CreativeMemory } from "./modules/agent/index.js";
export { Component } from "./modules/components/index.js";
export { Critique } from "./modules/critic/index.js";
export * from "./modules/editing/index.js";
export * from "./project-document.js";
export {
  AccountEmailConflict,
  normalizeEmail,
  operatorRole,
  RefreshSession,
  requireArgon2idHash,
  User,
} from "./modules/identity/index.js";
export type {
  ClearAttemptsResult,
  FailedAttemptResult,
  OperatorRole,
  RefreshRotation,
  RefreshSessionRepository,
  RefreshSessionSnapshot,
  RotationDecision,
  UserRepository,
  UserSnapshot,
} from "./modules/identity/index.js";
export { Job, JobAttempt, jobStatus } from "./modules/jobs/index.js";
export type {
  EnqueueJobCommand,
  EnqueueJobResult,
  JobDeadLetter,
  JobEnvelope,
  JobFailure,
  JobProgressEvent,
  JobQueue,
  JobReceipt,
  JobRepository,
  JobSnapshot,
  JobStatus,
  JobSubject,
  JobWork,
  ReservedJob,
} from "./modules/jobs/index.js";
export {
  Audio,
  assertMediaStorageKey,
  contentSha256,
  DerivedAsset,
  derivedAssetKind,
  displayFilename,
  Image,
  MAX_MEDIA_BYTES,
  MAX_MEDIA_DURATION,
  mediaByteSize,
  mediaDuration,
  mediaKind,
  mediaStorageKey,
  MediaAsset,
  MediaAssetConflict,
  MediaInspectionConflict,
  MediaProbeError,
  Video,
  videoMimeType,
} from "./modules/media/index.js";
export type {
  DerivedArtifact,
  DerivedAssetKind,
  DerivedAssetRepository,
  DerivedAssetSnapshot,
  FrameRateMode,
  IMediaProbe,
  IObjectStorage,
  InspectionFailureCode,
  InspectionStatus,
  LoadedMediaInspection,
  MediaAssetRepository,
  MediaAssetSnapshot,
  MediaKind,
  MediaStreamMetadata,
  MediaUploadMetadata,
  ProbeInput,
  ProbeResult,
  ObjectStat,
  PresignedGet,
  PresignedPut,
  PresignPutRequest,
  VideoMimeType,
} from "./modules/media/index.js";
export {
  BrandKit,
  membershipRole,
  Project,
  ProjectConflict,
  visibleProjects,
} from "./modules/projects/index.js";
export type {
  LoadedProject,
  ProjectMembership,
  ProjectMembershipRole,
  ProjectRepository,
  ProjectSnapshot,
} from "./modules/projects/index.js";
export { Tool } from "./modules/tools/index.js";

export { agentModule } from "./modules/agent/index.js";
export { analysisModule } from "./modules/analysis/index.js";
export { assetsModule } from "./modules/assets/index.js";
export { componentsModule } from "./modules/components/index.js";
export { criticModule } from "./modules/critic/index.js";
export { editingModule } from "./modules/editing/index.js";
export { identityModule } from "./modules/identity/index.js";
export { jobsModule } from "./modules/jobs/index.js";
export { mediaModule } from "./modules/media/index.js";
export { projectsModule } from "./modules/projects/index.js";
export { renderingModule } from "./modules/rendering/index.js";
export { toolsModule } from "./modules/tools/index.js";

import { agentModule } from "./modules/agent/index.js";
import { analysisModule } from "./modules/analysis/index.js";
import { assetsModule } from "./modules/assets/index.js";
import { componentsModule } from "./modules/components/index.js";
import { criticModule } from "./modules/critic/index.js";
import { editingModule } from "./modules/editing/index.js";
import { identityModule } from "./modules/identity/index.js";
import { jobsModule } from "./modules/jobs/index.js";
import { mediaModule } from "./modules/media/index.js";
import { projectsModule } from "./modules/projects/index.js";
import { renderingModule } from "./modules/rendering/index.js";
import { toolsModule } from "./modules/tools/index.js";

/** Bounded module ids. This is the public registry of module names. */
export const boundedModules = [
  agentModule,
  analysisModule,
  assetsModule,
  componentsModule,
  criticModule,
  editingModule,
  identityModule,
  jobsModule,
  mediaModule,
  projectsModule,
  renderingModule,
  toolsModule,
] as const;
export { PART_SIZE_BYTES, UPLOAD_SESSION_TTL_MS, uploadPartBytes } from "./modules/media/index.js";
export type {
  UploadSession,
  UploadPart,
  UploadSessionStatus,
  UploadSessionRepository,
  LockedUpload,
  StoragePart,
} from "./modules/media/index.js";

export * from "./modules/media/media-validation.js";

export * from "./modules/jobs/job-events.js";

export type {
  IAudioAnalyzer,
  AudioAnalysisInput,
  AudioAnalysisConfiguration,
} from "./modules/analysis/audio-analyzer.js";

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
export { frameIndex, frameRate, microseconds } from "./kernel/time.js";
export type { FrameIndex, FrameRate, Microseconds } from "./kernel/time.js";

export { AgentRun, CreativeMemory } from "./modules/agent/index.js";
export { Component } from "./modules/components/index.js";
export { Critique } from "./modules/critic/index.js";
export { Clip, Effect, Timeline, Track } from "./modules/editing/index.js";
export { User, operatorRole } from "./modules/identity/index.js";
export type { OperatorRole, UserRepository, UserSnapshot } from "./modules/identity/index.js";
export { Job, jobStatus } from "./modules/jobs/index.js";
export type { JobRepository, JobSnapshot, JobStatus, JobSubject } from "./modules/jobs/index.js";
export {
  Audio,
  DerivedAsset,
  derivedAssetKind,
  Image,
  MAX_MEDIA_DURATION,
  mediaDuration,
  mediaKind,
  MediaAsset,
  Video,
} from "./modules/media/index.js";
export type {
  DerivedAssetKind,
  DerivedAssetRepository,
  DerivedAssetSnapshot,
  MediaAssetRepository,
  MediaAssetSnapshot,
  MediaKind,
} from "./modules/media/index.js";
export { BrandKit, membershipRole, Project, visibleProjects } from "./modules/projects/index.js";
export type {
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

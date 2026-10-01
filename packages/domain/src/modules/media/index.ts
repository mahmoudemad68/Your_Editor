/** Public module id. Other modules must not import this folder. */
export const mediaModule = "media" as const;

export { DerivedAsset, derivedAssetKind } from "./derived-asset.js";
export type { DerivedAssetKind, DerivedAssetSnapshot } from "./derived-asset.js";
export {
  Audio,
  Image,
  MAX_MEDIA_DURATION,
  mediaDuration,
  mediaKind,
  MediaAsset,
  Video,
} from "./media-asset.js";
export type { MediaAssetSnapshot, MediaKind, MediaUploadMetadata } from "./media-asset.js";
export { MediaAssetConflict, MediaInspectionConflict } from "./media-repository.js";
export type { DerivedAssetRepository, MediaAssetRepository } from "./media-repository.js";
export {
  completedInspection,
  failedInspection,
  inspectionFailureCode,
  MediaProbeError,
  pendingInspection,
} from "./media-probe.js";
export type {
  FrameRateMode,
  IMediaProbe,
  InspectionFailureCode,
  InspectionStatus,
  MediaStreamMetadata,
  ProbeInput,
  ProbeResult,
} from "./media-probe.js";
export {
  assertMediaStorageKey,
  contentSha256,
  displayFilename,
  MAX_MEDIA_BYTES,
  mediaByteSize,
  mediaStorageKey,
  videoMimeType,
} from "./media-upload.js";
export type { VideoMimeType } from "./media-upload.js";
export type {
  IObjectStorage,
  ObjectStat,
  PresignedGet,
  PresignedPut,
  PresignPutRequest,
} from "./object-storage.js";

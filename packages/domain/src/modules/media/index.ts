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
export type { MediaAssetSnapshot, MediaKind } from "./media-asset.js";
export type { DerivedAssetRepository, MediaAssetRepository } from "./media-repository.js";

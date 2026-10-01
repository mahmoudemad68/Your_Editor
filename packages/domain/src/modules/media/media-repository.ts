import { DomainError } from "../../kernel/error.js";
import { type MediaAssetId, type ProjectId } from "../../kernel/id.js";
import { type DerivedAsset } from "./derived-asset.js";
import { type MediaAsset } from "./media-asset.js";

/** The same uploaded object was recorded twice for one Project. */
export class MediaAssetConflict extends DomainError {
  constructor() {
    super("This upload is already recorded.");
    this.name = "MediaAssetConflict";
  }
}

/** A stale inspection tried to replace a newer inspection result. */
export class MediaInspectionConflict extends DomainError {
  constructor() {
    super("Media inspection is stale.");
    this.name = "MediaInspectionConflict";
  }
}

/**
 * MediaAsset plus the inspection persistence token.
 * The revision is not media time and is not part of the MediaAsset aggregate.
 */
export interface LoadedMediaInspection {
  readonly asset: MediaAsset;
  readonly revision: bigint;
}

/** Persistence port. Object storage and Postgres adapters are later Media stories. */
export interface MediaAssetRepository {
  findById(id: MediaAssetId): Promise<MediaAsset | null>;
  listByProject(projectId: ProjectId): Promise<readonly MediaAsset[]>;
  save(asset: MediaAsset): Promise<void>;
  loadForInspection(id: MediaAssetId): Promise<LoadedMediaInspection | null>;
  /**
   * Stores inspection metadata only when inspection_revision still matches the
   * value observed before the probe started, then increments that revision.
   */
  saveInspection(asset: MediaAsset, expectedRevision: bigint): Promise<void>;
}

export interface DerivedAssetRepository {
  listByMediaAsset(mediaAssetId: MediaAssetId): Promise<readonly DerivedAsset[]>;
  save(asset: DerivedAsset): Promise<void>;
}

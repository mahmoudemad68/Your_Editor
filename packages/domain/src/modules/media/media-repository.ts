import { type MediaAssetId, type ProjectId } from "../../kernel/id.js";
import { type DerivedAsset } from "./derived-asset.js";
import { type MediaAsset } from "./media-asset.js";

/** Persistence port. Object storage and Postgres adapters are later Media stories. */
export interface MediaAssetRepository {
  findById(id: MediaAssetId): Promise<MediaAsset | null>;
  listByProject(projectId: ProjectId): Promise<readonly MediaAsset[]>;
  save(asset: MediaAsset): Promise<void>;
}

export interface DerivedAssetRepository {
  listByMediaAsset(mediaAssetId: MediaAssetId): Promise<readonly DerivedAsset[]>;
  save(asset: DerivedAsset): Promise<void>;
}

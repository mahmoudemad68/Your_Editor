import {
  type MediaAsset,
  MediaAssetConflict,
  type MediaAssetId,
  type MediaAssetRepository,
  type ProjectId,
} from "@editagent/domain";

export class InMemoryMediaAssetRepository implements MediaAssetRepository {
  private readonly rows = new Map<string, MediaAsset>();

  async findById(id: MediaAssetId): Promise<MediaAsset | null> {
    return this.rows.get(id) ?? null;
  }

  async listByProject(projectId: ProjectId): Promise<readonly MediaAsset[]> {
    return [...this.rows.values()].filter((asset) => asset.projectId === projectId);
  }

  async save(asset: MediaAsset): Promise<void> {
    if (this.rows.has(asset.id)) {
      throw new MediaAssetConflict();
    }
    for (const existing of this.rows.values()) {
      if (existing.projectId === asset.projectId && existing.storageKey === asset.storageKey) {
        throw new MediaAssetConflict();
      }
    }
    this.rows.set(asset.id, asset);
  }
}

import {
  type LoadedMediaInspection,
  type MediaAsset,
  MediaAssetConflict,
  type MediaAssetId,
  type MediaAssetRepository,
  MediaInspectionConflict,
  type ProjectId,
} from "@editagent/domain";

export class InMemoryMediaAssetRepository implements MediaAssetRepository {
  private readonly rows = new Map<string, MediaAsset>();
  private readonly revisions = new Map<string, bigint>();

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
    this.revisions.set(asset.id, 0n);
  }

  async loadForInspection(id: MediaAssetId): Promise<LoadedMediaInspection | null> {
    const asset = this.rows.get(id);
    if (asset === undefined) {
      return null;
    }
    return { asset, revision: this.revisions.get(id) ?? 0n };
  }

  async saveInspection(asset: MediaAsset, expectedRevision: bigint): Promise<void> {
    const current = this.revisions.get(asset.id);
    if (current === undefined || current !== expectedRevision) {
      throw new MediaInspectionConflict();
    }
    this.rows.set(asset.id, asset);
    this.revisions.set(asset.id, current + 1n);
  }
}

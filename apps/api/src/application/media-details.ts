import {
  DomainError,
  type MediaAsset,
  type MediaAssetId,
  type MediaAssetRepository,
  type ProjectId,
  type ProjectRepository,
  type UserId,
} from "@editagent/domain";
import { ProjectNotFoundError } from "./project-access.js";

/**
 * Reads one MediaAsset for any Project member.
 * It does not run FFprobe and it does not accept an actor id from the caller payload.
 */
export class GetMediaDetails {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly media: MediaAssetRepository,
  ) {}

  async execute(
    actorUserId: UserId,
    projectId: ProjectId,
    mediaAssetId: MediaAssetId,
  ): Promise<MediaAsset> {
    let loaded;
    try {
      loaded = await this.projects.findById(projectId);
    } catch (error) {
      // A corrupt membership snapshot cannot reveal existence through a distinct 400.
      if (error instanceof DomainError) throw new ProjectNotFoundError();
      throw error;
    }
    if (
      loaded === null ||
      !loaded.project.isListed() ||
      loaded.project.roleOf(actorUserId) === null
    ) {
      throw new ProjectNotFoundError();
    }
    const asset = await this.media.findById(mediaAssetId);
    if (asset === null || asset.projectId !== projectId) {
      throw new ProjectNotFoundError();
    }
    return asset;
  }
}

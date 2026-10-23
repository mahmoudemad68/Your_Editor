import { type AnalysisReader } from "@editagent/analysis-core";
import {
  type MediaAssetRepository,
  type MediaAssetId,
  type ProjectId,
  type UserId,
} from "@editagent/domain";
import { GetMediaDetails } from "./media-details.js";
import { ProjectNotFoundError } from "./project-access.js";
import { ProjectForbiddenError } from "./project-access.js";
import { type Analyzer } from "@editagent/analysis-core";

export class GetMediaAnalysis {
  constructor(
    private readonly details: GetMediaDetails,
    private readonly analysis: AnalysisReader,
    private readonly media: MediaAssetRepository,
  ) {}
  async executeForAsset(actor: UserId, id: MediaAssetId) {
    const source = await this.media.findById(id);
    if (!source) throw new ProjectNotFoundError();
    return this.execute(actor, source.projectId, id);
  }
  async rerun(actor: UserId, id: MediaAssetId, analyzer: Analyzer, previousJobId: string) {
    const source = await this.media.findById(id);
    if (!source) throw new ProjectNotFoundError();
    await this.details.execute(actor, source.projectId, id);
    if (!this.analysis.retry) throw new ProjectForbiddenError("Analyzer retry is unavailable.");
    let jobId: string;
    try {
      jobId = await this.analysis.retry(id, source.projectId, analyzer, previousJobId, actor);
    } catch {
      throw new ProjectForbiddenError("Analysis retry is unavailable or not permitted.");
    }
    return { jobId };
  }
  async execute(actor: UserId, project: ProjectId, asset: MediaAssetId) {
    const source = await this.details.execute(actor, project, asset);
    if (!source.contentSha256) throw new ProjectNotFoundError();
    const document = await this.analysis.read(asset, project, source.contentSha256);
    if (
      document &&
      source.duration !== null &&
      document.source.durationUs !== source.duration.toString()
    )
      throw new ProjectNotFoundError();
    // Revalidate after the durable read; no historical ownership or stale cached role.
    await this.details.execute(actor, project, asset);
    if (!document) throw new ProjectNotFoundError();
    return document;
  }
}

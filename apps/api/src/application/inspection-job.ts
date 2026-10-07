import type {
  JobStatus,
  MediaAssetId,
  ProjectId,
  ProjectRepository,
  UserId,
} from "@editagent/domain";
import { GetMediaDetails } from "./media-details.js";
import { ProjectForbiddenError, ProjectNotFoundError } from "./project-access.js";

/** Safe PostgreSQL read model. No payload or internal failure text crosses this port. */
export interface InspectionJobSnapshot {
  readonly jobId: string;
  readonly jobType: "media.inspect";
  readonly status: JobStatus;
  readonly attempt: number;
  readonly reason: "processing_failed" | "cancelled" | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sequence: number;
}
export interface InspectionJobs {
  latest(mediaId: MediaAssetId): Promise<InspectionJobSnapshot | null>;
  retry(
    mediaId: MediaAssetId,
    predecessorId: string,
    correlationId: string,
  ): Promise<InspectionJobSnapshot>;
}
export class InspectionRetryConflict extends Error {
  constructor() {
    super("Only a failed or cancelled inspection can be retried.");
  }
}
export class MediaInspectionJobs {
  constructor(
    private readonly details: GetMediaDetails,
    private readonly projects: ProjectRepository,
    private readonly jobs: InspectionJobs,
  ) {}
  async read(actor: UserId, project: ProjectId, media: MediaAssetId) {
    await this.details.execute(actor, project, media);
    return this.jobs.latest(media);
  }
  async retry(actor: UserId, project: ProjectId, media: MediaAssetId, correlation: string) {
    // The established media read predicate provides non-disclosure before role checks.
    await this.details.execute(actor, project, media);
    const loaded = await this.projects.findById(project);
    if (!loaded || !loaded.project.isListed() || loaded.project.roleOf(actor) === null) {
      throw new ProjectNotFoundError();
    }
    if (!["owner", "editor"].includes(loaded.project.roleOf(actor)!))
      throw new ProjectForbiddenError("Only an Owner or Editor can retry an inspection.");
    const previous = await this.jobs.latest(media);
    if (!previous || !["Failed", "Cancelled"].includes(previous.status))
      throw new InspectionRetryConflict();
    return this.jobs.retry(media, previous.jobId, correlation);
  }
}

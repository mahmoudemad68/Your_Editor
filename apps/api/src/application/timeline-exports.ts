import {
  Timeline,
  type IObjectStorage,
  type JobStatus,
  type ProjectId,
  type ProjectRepository,
  type UserId,
} from "@editagent/domain";
import { TimelineConflict, TimelineEditor } from "./timeline-editor.js";
import { ProjectForbiddenError, ProjectNotFoundError } from "./project-access.js";
import { RenderValidationV1Schema } from "@editagent/schemas";

export interface TimelineRenderSnapshot {
  readonly jobId: string;
  readonly status: JobStatus;
  readonly attempt: number;
  readonly updatedAt: string;
}
export interface TimelineRenderJobs {
  enqueue(actor: UserId, timeline: Timeline, requestId: string): Promise<TimelineRenderSnapshot>;
  read(
    project: ProjectId,
    id: string,
  ): Promise<{
    job: TimelineRenderSnapshot;
    outputKey: string | null;
    validation?: unknown;
  } | null>;
  cancel(actor: UserId, project: ProjectId, id: string): Promise<void>;
}
export class RenderUnavailable extends Error {
  constructor() {
    super("Rendering is not configured. Contact the project operator.");
  }
}

/** Export authorization surrounds durable Job reads and short-lived object signing. */
export class TimelineExports {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly editor: TimelineEditor,
    private readonly jobs: TimelineRenderJobs,
    private readonly objects: IObjectStorage,
    private readonly signDownload: (key: string, ttl: number) => Promise<{ url: string }>,
  ) {}

  private async access(actor: UserId, project: ProjectId, write: boolean) {
    const loaded = await this.projects.findById(project);
    const role = loaded?.project.roleOf(actor);
    if (!loaded?.project.isListed() || !role) throw new ProjectNotFoundError();
    if (write && role !== "owner" && role !== "editor")
      throw new ProjectForbiddenError("Only an Owner or Editor can render or cancel exports.");
  }

  async start(
    actor: UserId,
    project: ProjectId,
    timeline: string,
    expectedSha256: string,
    requestId: string,
  ) {
    await this.access(actor, project, true);
    const stored = await this.editor.read(actor, project, timeline);
    if (stored.stateSha256 !== expectedSha256) throw new TimelineConflict();
    return this.jobs.enqueue(actor, Timeline.restore(stored.timeline), requestId);
  }

  async read(actor: UserId, project: ProjectId, id: string) {
    await this.access(actor, project, false);
    const result = await this.jobs.read(project, id);
    await this.access(actor, project, false);
    if (!result) throw new ProjectNotFoundError();
    return result.job;
  }

  async cancel(actor: UserId, project: ProjectId, id: string) {
    await this.access(actor, project, true);
    if (!(await this.jobs.read(project, id))) throw new ProjectNotFoundError();
    await this.jobs.cancel(actor, project, id);
    return this.read(actor, project, id);
  }
  async validation(actor: UserId, project: ProjectId, id: string) {
    await this.access(actor, project, false);
    const result = await this.jobs.read(project, id);
    await this.access(actor, project, false);
    if (!result) throw new ProjectNotFoundError();
    const parsed = RenderValidationV1Schema.safeParse(result.validation);
    if (result.job.status !== "Completed" || !parsed.success || parsed.data.jobId !== id)
      throw new TimelineConflict();
    return parsed.data;
  }

  async download(actor: UserId, project: ProjectId, id: string) {
    await this.access(actor, project, false);
    const result = await this.jobs.read(project, id);
    if (!result) throw new ProjectNotFoundError();
    if (result.job.status !== "Completed" || !result.outputKey) throw new TimelineConflict();
    const [preview, download] = await Promise.all([
      this.objects.presignGet(result.outputKey, 60),
      this.signDownload(result.outputKey, 60),
    ]);
    await this.access(actor, project, false);
    return { previewUrl: preview.url, downloadUrl: download.url, expiresInSeconds: 60 };
  }
}

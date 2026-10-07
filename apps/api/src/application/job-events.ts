import {
  type JobEventSubscriber,
  type ProjectId,
  type ProjectRepository,
  type UserId,
} from "@editagent/domain";
import { ProjectNotFoundError } from "./project-access.js";

export class ProjectJobEvents {
  private readonly clients = new Set<() => void>();
  constructor(
    private readonly projects: ProjectRepository,
    readonly subscriber: JobEventSubscriber,
  ) {}
  async authorize(actor: UserId, id: ProjectId): Promise<void> {
    const loaded = await this.projects.findById(id);
    if (!loaded || !loaded.project.isListed() || loaded.project.roleOf(actor) === null)
      throw new ProjectNotFoundError();
  }
  track(close: () => void): () => void {
    this.clients.add(close);
    return () => this.clients.delete(close);
  }
  async onModuleDestroy(): Promise<void> {
    for (const close of this.clients) close();
    this.clients.clear();
    await this.subscriber.close();
  }
}

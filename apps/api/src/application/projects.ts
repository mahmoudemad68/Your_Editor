import { Project, type ProjectId, type ProjectRepository, type UserId } from "@editagent/domain";
import { type Clock, type ProjectIdGenerator } from "./clock.js";
import { ProjectForbiddenError, ProjectNotFoundError } from "./project-access.js";

/**
 * CreateProject, RenameProject, ListProjects, and DeleteProject.
 * Membership rules stay here and in the Project aggregate. Controllers only deliver them.
 */

async function visibleProject(
  projects: ProjectRepository,
  id: ProjectId,
  actorUserId: UserId,
): Promise<Project> {
  const project = await projects.findById(id);
  if (project === null || !project.isListed() || project.roleOf(actorUserId) === null) {
    throw new ProjectNotFoundError();
  }
  return project;
}

export class CreateProject {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly ids: ProjectIdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(actorUserId: UserId, name: string): Promise<Project> {
    const at = this.clock.now();
    const project = Project.create(this.ids.next(at), name, actorUserId, at);
    await this.projects.save(project, null);
    return project;
  }
}

export class RenameProject {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly clock: Clock,
  ) {}

  async execute(actorUserId: UserId, id: ProjectId, name: string): Promise<Project> {
    const current = await visibleProject(this.projects, id, actorUserId);
    const role = current.roleOf(actorUserId);
    if (role !== "owner" && role !== "editor") {
      throw new ProjectForbiddenError("Only an Owner or Editor can rename a Project.");
    }
    const renamed = current.rename(actorUserId, name, this.clock.now());
    await this.projects.save(renamed, current.updatedAt);
    return renamed;
  }
}

export class ListProjects {
  constructor(private readonly projects: ProjectRepository) {}

  async execute(actorUserId: UserId): Promise<readonly Project[]> {
    const projects = await this.projects.listForMember(actorUserId);
    return projects.filter((project) => project.isListed() && project.roleOf(actorUserId) !== null);
  }
}

export class DeleteProject {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly clock: Clock,
  ) {}

  async execute(actorUserId: UserId, id: ProjectId): Promise<void> {
    const current = await visibleProject(this.projects, id, actorUserId);
    if (current.roleOf(actorUserId) !== "owner") {
      throw new ProjectForbiddenError("Only an Owner can delete a Project.");
    }
    const deleted = current.deleteProject(actorUserId, this.clock.now());
    await this.projects.save(deleted, current.updatedAt);
  }
}

import {
  type Instant,
  type Project,
  ProjectConflict,
  type ProjectId,
  type ProjectRepository,
  type UserId,
} from "@editagent/domain";

/** Test double for ProjectRepository. It keeps soft-deleted rows and hides them from lists. */
export class InMemoryProjectRepository implements ProjectRepository {
  private readonly rows = new Map<string, Project>();

  async findById(id: ProjectId): Promise<Project | null> {
    return this.rows.get(id) ?? null;
  }

  async listForMember(userId: UserId): Promise<readonly Project[]> {
    return [...this.rows.values()]
      .filter((project) => project.isListed() && project.roleOf(userId) !== null)
      .sort((left, right) => {
        if (left.createdAt < right.createdAt) {
          return -1;
        }
        if (left.createdAt > right.createdAt) {
          return 1;
        }
        if (left.id < right.id) {
          return -1;
        }
        if (left.id > right.id) {
          return 1;
        }
        return 0;
      });
  }

  async save(project: Project, expectedUpdatedAt: Instant | null): Promise<void> {
    const existing = this.rows.get(project.id) ?? null;
    if (expectedUpdatedAt === null) {
      if (existing !== null) {
        throw new ProjectConflict();
      }
      this.rows.set(project.id, project);
      return;
    }
    if (existing === null || existing.updatedAt !== expectedUpdatedAt) {
      throw new ProjectConflict();
    }
    this.rows.set(project.id, project);
  }
}

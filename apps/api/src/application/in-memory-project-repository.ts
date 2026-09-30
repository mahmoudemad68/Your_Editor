import {
  type LoadedProject,
  type Project,
  ProjectConflict,
  type ProjectId,
  type ProjectRepository,
  type UserId,
} from "@editagent/domain";

interface StoredProject {
  readonly project: Project;
  readonly revision: bigint;
}

/** Test double for ProjectRepository. It keeps soft-deleted rows and hides them from lists. */
export class InMemoryProjectRepository implements ProjectRepository {
  private readonly rows = new Map<string, StoredProject>();

  async findById(id: ProjectId): Promise<LoadedProject | null> {
    const stored = this.rows.get(id);
    if (stored === undefined) {
      return null;
    }
    return { project: stored.project, revision: stored.revision };
  }

  async listForMember(userId: UserId): Promise<readonly Project[]> {
    const seen = new Set<string>();
    return [...this.rows.values()]
      .filter((stored) => {
        if (seen.has(stored.project.id) || !stored.project.isListed()) {
          return false;
        }
        if (stored.project.roleOf(userId) === null) {
          return false;
        }
        seen.add(stored.project.id);
        return true;
      })
      .sort((left, right) => compareProjects(left.project, right.project))
      .map((stored) => stored.project);
  }

  async save(project: Project, expectedRevision: bigint | null): Promise<void> {
    const existing = this.rows.get(project.id) ?? null;
    if (expectedRevision === null) {
      if (existing !== null) {
        throw new ProjectConflict();
      }
      this.rows.set(project.id, { project, revision: 0n });
      return;
    }
    if (existing === null || existing.revision !== expectedRevision) {
      throw new ProjectConflict();
    }
    this.rows.set(project.id, { project, revision: existing.revision + 1n });
  }
}

function compareProjects(left: Project, right: Project): number {
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
}

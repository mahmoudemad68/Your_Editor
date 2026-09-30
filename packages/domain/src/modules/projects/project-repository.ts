import { type ProjectId, type UserId } from "../../kernel/id.js";
import { type Project } from "./project.js";

/**
 * Persistence port for the Project aggregate, including its memberships.
 * US-120 owns the Postgres repository and migrations. This interface has no ORM types.
 */
export interface ProjectRepository {
  findById(id: ProjectId): Promise<Project | null>;
  /** Normal listings. Implementations must exclude soft-deleted Projects. */
  listForMember(userId: UserId): Promise<readonly Project[]>;
  save(project: Project): Promise<void>;
}

import { type Instant } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import { type ProjectId, type UserId } from "../../kernel/id.js";
import { type Project } from "./project.js";

/**
 * The stored Project changed after it was loaded.
 * Callers must reload instead of overwriting the newer row.
 */
export class ProjectConflict extends DomainError {
  constructor() {
    super("The Project changed since it was loaded.");
    this.name = "ProjectConflict";
  }
}

/**
 * Persistence port for the Project aggregate, including its memberships.
 * The Postgres adapter lives outside this package. This interface has no ORM types.
 * Pass null as expectedUpdatedAt to insert. An update is conditional on that instant.
 */
export interface ProjectRepository {
  findById(id: ProjectId): Promise<Project | null>;
  /** Normal listings. Implementations must exclude soft-deleted Projects. */
  listForMember(userId: UserId): Promise<readonly Project[]>;
  save(project: Project, expectedUpdatedAt: Instant | null): Promise<void>;
}

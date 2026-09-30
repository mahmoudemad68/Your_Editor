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
 * A Project loaded with its persistence concurrency token.
 * revision is not audit time and is not part of the Project aggregate.
 */
export interface LoadedProject {
  readonly project: Project;
  readonly revision: bigint;
}

/**
 * Persistence port for the Project aggregate, including its memberships.
 * The Postgres adapter lives outside this package. This interface has no ORM types.
 * Pass null as expectedRevision to insert at revision 0.
 * An update changes the row only when expectedRevision still matches, then increments it.
 */
export interface ProjectRepository {
  findById(id: ProjectId): Promise<LoadedProject | null>;
  /** Normal listings. Implementations must exclude soft-deleted Projects. */
  listForMember(userId: UserId): Promise<readonly Project[]>;
  save(project: Project, expectedRevision: bigint | null): Promise<void>;
}

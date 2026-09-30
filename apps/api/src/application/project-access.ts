/** The caller must not learn whether this Project id exists. */
export class ProjectNotFoundError extends Error {
  constructor() {
    super("Project not found.");
    this.name = "ProjectNotFoundError";
  }
}

/** A member whose role cannot perform the command. */
export class ProjectForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectForbiddenError";
  }
}

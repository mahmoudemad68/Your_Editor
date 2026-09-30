/** Canonical Critique name. Quality checks and refinement are later Critic stories. */

import { type CritiqueId, type ProjectId } from "../../kernel/id.js";

export class Critique {
  readonly id: CritiqueId;
  readonly projectId: ProjectId;

  private constructor(id: CritiqueId, projectId: ProjectId) {
    this.id = id;
    this.projectId = projectId;
  }

  static create(id: CritiqueId, projectId: ProjectId): Critique {
    return new Critique(id, projectId);
  }
}

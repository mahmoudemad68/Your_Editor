/** Canonical Critique name. Quality checks and refinement are later Critic stories. */

import { type CritiqueId, critiqueId, type ProjectId, projectId } from "../../kernel/id.js";

export class Critique {
  readonly id: CritiqueId;
  readonly projectId: ProjectId;

  constructor(id: CritiqueId | string, projectIdValue: ProjectId | string) {
    this.id = critiqueId(String(id));
    this.projectId = projectId(String(projectIdValue));
    Object.freeze(this);
  }

  static create(id: CritiqueId, projectIdValue: ProjectId): Critique {
    return new Critique(id, projectIdValue);
  }
}

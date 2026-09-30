/**
 * Canonical Agent names. The observe-plan-act loop is a later Agent story.
 */

import { type Instant, instant } from "../../kernel/clock.js";
import { type AgentRunId, type CreativeMemoryId, type ProjectId } from "../../kernel/id.js";

export class AgentRun {
  readonly id: AgentRunId;
  readonly projectId: ProjectId;
  readonly createdAt: Instant;

  private constructor(id: AgentRunId, projectId: ProjectId, createdAt: Instant) {
    this.id = id;
    this.projectId = projectId;
    this.createdAt = createdAt;
  }

  static create(id: AgentRunId, projectId: ProjectId, createdAt: Instant): AgentRun {
    return new AgentRun(id, projectId, instant(createdAt));
  }
}

export class CreativeMemory {
  readonly id: CreativeMemoryId;
  readonly projectId: ProjectId;

  private constructor(id: CreativeMemoryId, projectId: ProjectId) {
    this.id = id;
    this.projectId = projectId;
  }

  static create(id: CreativeMemoryId, projectId: ProjectId): CreativeMemory {
    return new CreativeMemory(id, projectId);
  }
}

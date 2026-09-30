/**
 * Canonical Agent names. The observe-plan-act loop is a later Agent story.
 */

import { type Instant, instant } from "../../kernel/clock.js";
import {
  type AgentRunId,
  agentRunId,
  type CreativeMemoryId,
  creativeMemoryId,
  type ProjectId,
  projectId,
} from "../../kernel/id.js";

export class AgentRun {
  readonly id: AgentRunId;
  readonly projectId: ProjectId;
  readonly createdAt: Instant;

  constructor(
    id: AgentRunId | string,
    projectIdValue: ProjectId | string,
    createdAt: Instant | string | bigint,
  ) {
    this.id = agentRunId(String(id));
    this.projectId = projectId(String(projectIdValue));
    this.createdAt = instant(createdAt);
    Object.freeze(this);
  }

  static create(id: AgentRunId, projectIdValue: ProjectId, createdAt: Instant): AgentRun {
    return new AgentRun(id, projectIdValue, createdAt);
  }
}

export class CreativeMemory {
  readonly id: CreativeMemoryId;
  readonly projectId: ProjectId;

  constructor(id: CreativeMemoryId | string, projectIdValue: ProjectId | string) {
    this.id = creativeMemoryId(String(id));
    this.projectId = projectId(String(projectIdValue));
    Object.freeze(this);
  }

  static create(id: CreativeMemoryId, projectIdValue: ProjectId): CreativeMemory {
    return new CreativeMemory(id, projectIdValue);
  }
}

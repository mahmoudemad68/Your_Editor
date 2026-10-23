import { DomainError } from "@editagent/domain";
import {
  PostgresToolAuditRepository,
  PostgresToolAuthority,
  ToolError,
  ToolExecutor,
  ToolRegistry,
  registerEditingTools,
} from "@editagent/tool-sdk";
import type { Pool } from "pg";
import type { TimelineProposals, TimelineStore } from "../application/timeline-editor.js";
import { ProjectNotFoundError } from "../application/project-access.js";

/** The existing audited, in-process trim/split tools; API never runs media binaries. */
export function timelineProposals(pool: Pool, store: TimelineStore): TimelineProposals {
  const authority = new PostgresToolAuthority(
    pool,
    async (project, id) =>
      (await store.load(project as Parameters<TimelineStore["load"]>[0], id)).timeline,
  );
  const executor = new ToolExecutor(
    registerEditingTools(new ToolRegistry(), authority),
    authority,
    new PostgresToolAuditRepository(pool, 1_000_000),
  );
  return {
    async propose(actor, project, timeline, operation, input) {
      try {
        const result = await executor.execute({
          name: `editing.${operation}`,
          version: "1.0.0",
          callerId: actor,
          projectId: project,
          resource: { kind: "timeline", id: timeline },
          input,
        });
        const output = result.output as { basisSha256: string };
        return { basisSha256: output.basisSha256, commands: result.commands };
      } catch (error) {
        if (error instanceof ToolError && error.code === "denied") throw new ProjectNotFoundError();
        if (
          error instanceof ToolError &&
          ["invalid_input", "invalid_commands", "invalid_subject"].includes(error.code)
        )
          throw new DomainError("The edit is outside the selected clip or has invalid parameters.");
        throw error;
      }
    },
  };
}

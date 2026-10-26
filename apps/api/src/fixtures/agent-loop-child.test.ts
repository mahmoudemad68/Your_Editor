/** IPC-only crash qualification; stripped from production images. */
import { Pool } from "pg";
import { Timeline } from "@editagent/domain";
import {
  PostgresAgentRuns,
  PostgresAgentContextSource,
  runControlledAgentLoop,
  type AgentRenderPort,
} from "@editagent/agent-core";
import {
  PostgresToolAuthority,
  ToolRegistry,
  registerEditingTools,
  ToolExecutor,
  PostgresToolAuditRepository,
} from "@editagent/tool-sdk";
import { qualificationModel } from "./agent-loop-provider.test.js";
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const runs = new PostgresAgentRuns(pool),
      id = process.env.AGENT_TEST_RUN!;
    const snapshot = (
      await pool.query<{ source_snapshot: unknown }>(
        "SELECT source_snapshot FROM agent_runs WHERE id=$1",
        [id],
      )
    ).rows[0]!.source_snapshot;
    const authority = new PostgresToolAuthority(pool, async (project, timeline) =>
      Timeline.restore(
        (
          await pool.query("SELECT snapshot FROM editing_timelines WHERE id=$1 AND project_id=$2", [
            timeline,
            project,
          ])
        ).rows[0]!.snapshot,
      ),
    );
    const registry = registerEditingTools(new ToolRegistry(), authority),
      source = new PostgresAgentContextSource(pool, registry, {
        pins: [
          { name: "editing.trim-video", version: "1.0.0" },
          { name: "editing.split-video", version: "1.0.0" },
        ],
        creativity: ["conservative"],
      });
    const unavailable = async () => {
      throw new Error("test_render_boundary_not_reached");
    };
    const render: AgentRenderPort = {
      start: unavailable,
      reconcile: unavailable,
      inspect: unavailable,
      async cancel() {},
    };
    await runControlledAgentLoop(
      {
        runs,
        source,
        registry,
        authority,
        executor: new ToolExecutor(
          registry,
          authority,
          new PostgresToolAuditRepository(pool, 1000000),
        ),
        model: qualificationModel(Timeline.restore(snapshot).toSnapshot()),
        render,
      },
      id,
      new AbortController().signal,
    );
    process.send?.({ phase: "finished" });
  } finally {
    await pool.end();
    process.disconnect?.();
  }
}
if (require.main === module && process.send)
  void main().catch(() => {
    process.send?.({ phase: "controlled_fixture_failed" });
    process.exitCode = 1;
    process.disconnect?.();
  });

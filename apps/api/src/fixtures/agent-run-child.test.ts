/** Test-only scripted driver. Docker strips *.test.js from production images.
 * It is neither selected nor imported by any production composition root. */
import { Pool } from "pg";
import { PostgresAgentRuns, executeAgentTool, newAgentId } from "@editagent/agent-core";
import { Timeline } from "@editagent/domain";
import {
  PostgresToolAuditRepository,
  PostgresToolAuthority,
  ToolExecutor,
  ToolRegistry,
  registerEditingTools,
  type ToolCall,
} from "@editagent/tool-sdk";

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const runs = new PostgresAgentRuns(pool),
      id = process.env.AGENT_TEST_RUN!;
    const lease = await runs.claim(id, newAgentId());
    if (!lease) throw new Error("test_claim_failed");
    const load = async (project: string, timeline: string) =>
      Timeline.restore(
        (
          await pool.query("SELECT snapshot FROM editing_timelines WHERE id=$1 AND project_id=$2", [
            timeline,
            project,
          ])
        ).rows[0].snapshot,
      );
    const authority = new PostgresToolAuthority(pool, load);
    const executor = new ToolExecutor(
      registerEditingTools(new ToolRegistry(), authority),
      authority,
      new PostgresToolAuditRepository(pool, 1_000_000),
    );
    let run = await runs.workerView(lease);
    if (run.state === "Pending") {
      await runs.move(lease, "Observing");
      await runs.move(lease, "Planning");
      await runs.move(lease, "Executing");
    }
    run = await runs.workerView(lease);
    const snapshot = await load(run.projectId, run.source!.timelineId);
    for (let index = run.checkpoint; index < 2; index++) {
      const call: ToolCall = {
        name: "editing.trim-video",
        version: "1.0.0",
        callerId: await runs.workerActor(lease),
        projectId: run.projectId,
        resource: { kind: "timeline", id: snapshot.id },
        input: {
          clipId: snapshot.tracks[0]!.clips[0]!.id,
          startUs: index === 0 ? "200000" : "400000",
          endUs: index === 0 ? "1800000" : "1600000",
        },
      };
      if (process.env.AGENT_TEST_MODE === "unconfirmed") {
        const step = await runs.beginStep(lease, call.name, call.version, call.input);
        if (!step) {
          process.send?.({ phase: "unconfirmed_failed" });
          return;
        }
        await executor.executeWithIdentity(step.receiptId, call);
        process.send?.({ phase: "admitted_without_checkpoint" });
        await new Promise(() => undefined);
      }
      if (!(await executeAgentTool(runs, lease, executor, call, new AbortController().signal))) {
        process.send?.({ phase: "failed" });
        return;
      }
      process.send?.({ phase: "checkpoint", index: index + 1 });
      if (process.env.AGENT_TEST_MODE === "checkpoint") await new Promise(() => undefined);
    }
    await runs.move(lease, "Evaluating");
    await runs.move(lease, "Completed");
    process.send?.({ phase: "completed" });
  } finally {
    await pool.end();
    process.disconnect?.();
  }
}
if (require.main === module && process.send)
  void main().catch(() => {
    process.send?.({ phase: "test_driver_failed" });
    process.exitCode = 1;
    process.disconnect?.();
  });

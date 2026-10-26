import { Timeline } from "@editagent/domain";
import {
  AgentError,
  PostgresAgentRuns,
  PostgresAgentContextSource,
  consumeControlledAgentRuns,
  runControlledAgentLoop,
  runInfrastructure,
  type LanguageModel,
  type AgentRenderPort,
  type PromptRegistry,
} from "@editagent/agent-core";
import {
  PostgresToolAuditRepository,
  PostgresToolAuthority,
  ToolExecutor,
  ToolRegistry,
  registerEditingTools,
  contentHash,
} from "@editagent/tool-sdk";
import type { JobQueue } from "@editagent/domain";
import type { Pool } from "pg";

export interface ControlledWorkerComposition {
  pool: Pool;
  queue: JobQueue;
  modelForRun: (runId: string) => Promise<LanguageModel>;
  render: AgentRenderPort;
  prompts?: PromptRegistry;
}
/** Library entry for explicitly invoked isolated qualification. Normal index.ts
 * never imports/selects this function, even if environment flags are injected.
 * Uses actual PG/BullMQ and Tool SDK, not a scripted effect executor. */
export async function consumeControlledWorker(
  c: ControlledWorkerComposition,
  signal: AbortSignal,
  onError: () => void,
): Promise<void> {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.EDITAGENT_REPLAY_QUALIFICATION !== "isolated-v1"
  )
    throw new AgentError("forbidden");
  const runs = new PostgresAgentRuns(c.pool);
  const authority = new PostgresToolAuthority(c.pool, async (project, id) => {
    const row = (
      await c.pool.query<{ snapshot: unknown; state_sha256: string }>(
        "SELECT snapshot,state_sha256 FROM editing_timelines WHERE id=$1 AND project_id=$2",
        [id, project],
      )
    ).rows[0];
    if (!row || contentHash(row.snapshot) !== row.state_sha256) throw new AgentError("fenced");
    return Timeline.restore(row.snapshot);
  });
  const registry = registerEditingTools(new ToolRegistry(), authority);
  const source = new PostgresAgentContextSource(c.pool, registry, {
    pins: [
      { name: "editing.trim-video", version: "1.0.0" },
      { name: "editing.split-video", version: "1.0.0" },
    ],
    creativity: ["conservative", "balanced", "creative"],
  });
  const executor = new ToolExecutor(
    registry,
    authority,
    new PostgresToolAuditRepository(c.pool, 1_000_000),
  );
  await consumeControlledAgentRuns(runs, c.queue, signal, onError, async (_runs, id, jobSignal) => {
    const row = (
      await c.pool.query<{ runtime_driver: string }>(
        "SELECT runtime_driver FROM agent_runs WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (row?.runtime_driver !== "controlled-loop-v1") return runInfrastructure(runs, id, jobSignal);
    const model = await c.modelForRun(id);
    await runControlledAgentLoop(
      {
        runs,
        source,
        registry,
        authority,
        executor,
        model,
        render: c.render,
        ...(c.prompts ? { prompts: c.prompts } : {}),
      },
      id,
      jobSignal,
    );
  });
}

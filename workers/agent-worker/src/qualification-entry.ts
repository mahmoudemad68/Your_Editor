/** Explicit alternate isolated-test entry. Never selected by production main,
 * admission input or normal environment configuration. No live/paid model. */
import { Pool } from "pg";
import { BullMqJobQueue } from "@editagent/job-queue";
import { AgentError, PostgresAgentRuns, type ProviderCapabilities } from "@editagent/agent-core";
import { consumeControlledWorker } from "./controlled.js";
import { AuthenticatedTimelineRenderPort } from "./render-port.js";
import { ControlledReplayScenario } from "./replay-scenario.js";

async function main(): Promise<void> {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.EDITAGENT_REPLAY_QUALIFICATION !== "isolated-v1" ||
    process.env.EDITAGENT_RUNTIME !== "development"
  )
    throw new AgentError("forbidden");
  const chunks: Buffer[] = [];
  let bytes = 0;
  const inputTimer = setTimeout(() => process.stdin.destroy(new AgentError("invalid_input")), 5000);
  try {
    for await (const raw of process.stdin) {
      const chunk = raw as Buffer;
      bytes += chunk.length;
      if (bytes > 32768) throw new AgentError("invalid_input");
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(inputTimer);
  }
  const input = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  ) as {
    mode: string;
    runId: string;
    projectId: string;
    actorId: string;
    apiOrigin: string;
    accessToken: string;
    csrf: string;
    plan: unknown;
    capabilities: ProviderCapabilities;
  };
  if (
    !input ||
    input.mode !== "isolated-replay-v1" ||
    typeof input.accessToken !== "string" ||
    input.accessToken.length > 4096 ||
    typeof input.csrf !== "string" ||
    input.csrf.length > 128
  )
    throw new AgentError("invalid_input");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 6,
    connectionTimeoutMillis: 2000,
    query_timeout: 5000,
  });
  const queue = new BullMqJobQueue(process.env.REDIS_URL!),
    stop = new AbortController();
  const deadline = setTimeout(() => stop.abort(), 125000);
  process.once("SIGTERM", () => stop.abort());
  process.once("SIGINT", () => stop.abort());
  let consumed: Promise<void> | undefined;
  try {
    const runs = new PostgresAgentRuns(pool),
      model = new ControlledReplayScenario(input.capabilities, input.plan);
    const current = await runs.get(input.actorId, input.projectId, input.runId);
    if (current.runtime.driver !== "controlled-loop-v1") throw new AgentError("forbidden");
    const render = new AuthenticatedTimelineRenderPort(
      pool,
      queue,
      input.apiOrigin,
      async (actor) => {
        if (actor !== input.actorId) throw new AgentError("forbidden");
        return {
          cookie: `editagent_access=${input.accessToken}; editagent_csrf=${input.csrf}`,
          "x-editagent-csrf": input.csrf,
        };
      },
    );
    let errors = 0;
    consumed = consumeControlledWorker(
      {
        pool,
        queue,
        modelForRun: async (id) => {
          if (id !== input.runId) throw new AgentError("forbidden");
          return model;
        },
        render,
      },
      stop.signal,
      () => {
        errors++;
      },
    );
    for (;;) {
      if (stop.signal.aborted) throw new AgentError("fenced");
      const result = await runs.get(input.actorId, input.projectId, input.runId);
      const job = (
        await pool.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1", [input.runId])
      ).rows[0];
      if (
        ["Completed", "Failed", "Cancelled"].includes(result.state) &&
        job &&
        ["Completed", "Failed", "Cancelled"].includes(job.status)
      ) {
        if (result.state !== "Completed" || errors > 0) throw new AgentError("conflict");
        process.stdout.write(
          JSON.stringify({
            status: "PASS",
            runtime: "actual_packaged_controlled_worker",
            runId: result.id,
            state: result.state,
            checkpoint: result.checkpoint,
            modelEvidence: "synthetic_replay",
            productionEnabled: false,
            plannerQualification: "NOT_VERIFIED",
            renderJobId: result.planning?.renderJobId,
          }) + "\n",
        );
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    clearTimeout(deadline);
    stop.abort();
    await consumed?.catch(() => undefined);
    await queue.close(true);
    await pool.end();
  }
}
if (require.main === module)
  void main().catch(() => {
    process.stderr.write("controlled_qualification_failed\n");
    process.exitCode = 1;
  });

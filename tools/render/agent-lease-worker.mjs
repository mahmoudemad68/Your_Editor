/** Linux-only test driver of the real compiled loop/SDK/render port. IPC is
 * ephemeral fixture state, never a production entry or a published session. */
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { Pool } from "pg";

const root = path.resolve(import.meta.dirname, "../.."),
  require = createRequire(path.join(root, "apps/api/package.json"));
const core = require("@editagent/agent-core"),
  sdk = require("@editagent/tool-sdk"),
  domain = require("@editagent/domain"),
  jobs = require("@editagent/job-queue");
const { AuthenticatedTimelineRenderPort } = require(
  path.join(root, "workers/agent-worker/dist/render-port.js"),
);
const { ControlledReplayScenario } = require(
  path.join(root, "workers/agent-worker/dist/replay-scenario.js"),
);

async function main(input) {
  if (!process.send || process.platform !== "linux" || !["A", "B"].includes(input.worker))
    throw new Error("fixture_only");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    application_name: input.applicationName,
    connectionTimeoutMillis: 2000,
    query_timeout: 5000,
    max: 4,
  });
  const queue = new jobs.BullMqJobQueue(process.env.REDIS_URL);
  const permit = core.createControlledReplayPermit({
    nodeEnvironment: "test",
    runtime: "development",
    qualification: "isolated-v1",
  });
  const runs = new core.PostgresAgentRuns(pool, permit),
    renew = runs.renew.bind(runs),
    activeRenewals = new Set();
  let blocked = false,
    released = false,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const accept = (message) => {
    if (message?.command === "release") {
      released = true;
      release();
    }
  };
  process.on("message", accept);
  // Stop at a boundary outside every DB transaction. For A only, future
  // heartbeat requests wait in test memory so SIGSTOP cannot strand a row lock.
  // B continues renewing normally while its inspector waits at the barrier.
  runs.renew = async (lease) => {
    if (blocked && input.worker === "A") await gate;
    const pending = renew(lease);
    activeRenewals.add(pending);
    try {
      await pending;
    } finally {
      activeRenewals.delete(pending);
    }
  };
  const authority = new sdk.PostgresToolAuthority(pool, async (project, id) => {
    const row = (
      await pool.query("SELECT snapshot FROM editing_timelines WHERE project_id=$1 AND id=$2", [
        project,
        id,
      ])
    ).rows[0];
    return domain.Timeline.restore(row.snapshot);
  });
  const registry = sdk.registerEditingTools(new sdk.ToolRegistry(), authority);
  const source = new core.PostgresAgentContextSource(pool, registry, {
    pins: [
      { name: "editing.trim-video", version: "1.0.0" },
      { name: "editing.split-video", version: "1.0.0" },
    ],
    creativity: ["conservative"],
  });
  const actual = new AuthenticatedTimelineRenderPort(
    pool,
    queue,
    input.apiOrigin,
    async (actor) => {
      if (actor !== input.actorId) throw new core.AgentError("forbidden");
      return {
        cookie: `editagent_access=${input.accessToken}; editagent_csrf=${input.csrf}`,
        "x-editagent-csrf": input.csrf,
      };
    },
    permit,
  );
  const render = {
    start: (...args) => actual.start(...args),
    reconcile: (...args) => actual.reconcile(...args),
    cancel: (...args) => actual.cancel(...args),
    async inspect(...args) {
      const result = await actual.inspect(...args);
      if (!blocked) {
        if (result.status !== "pending") throw new Error("expected_paused_render");
        blocked = true;
        await Promise.all([...activeRenewals]);
        process.send({ phase: "render_wait", jobId: args[1] });
        if (!released) await gate;
      }
      return result;
    },
  };
  try {
    await core.runControlledAgentLoop(
      {
        runs,
        source,
        registry,
        authority,
        executor: new sdk.ToolExecutor(
          registry,
          authority,
          new sdk.PostgresToolAuditRepository(pool, 1000000),
        ),
        model: new ControlledReplayScenario(input.capabilities, input.plan, permit),
        render,
      },
      input.runId,
      new globalThis.AbortController().signal,
    );
    const result = await runs.get(input.actorId, input.projectId, input.runId);
    process.send({
      phase: "finished",
      state: result.state,
      checkpoint: result.checkpoint,
      generation: result.generation,
    });
  } catch (error) {
    if (!(error instanceof core.AgentError) || error.code !== "fenced") throw error;
    process.send({ phase: "fenced" });
  } finally {
    release();
    process.off("message", accept);
    await queue.close(true);
    await pool.end();
    process.disconnect();
  }
}
process.once(
  "message",
  (input) =>
    void main(input).catch(() => {
      process.send?.({ phase: "fixture_failed" });
      process.exitCode = 1;
      process.disconnect?.();
    }),
);

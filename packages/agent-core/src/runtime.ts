import { instant, projectId, jobId, type JobQueue } from "@editagent/domain";
import { enqueueJob, PostgresJobRepository, runNextJob } from "@editagent/job-queue";
import { ToolExecutor, ToolError, type ToolCall } from "@editagent/tool-sdk";
import { AgentError, AGENT_QUEUE, AGENT_JOB_TYPE, AGENT_DEADLINE_MS } from "./contracts.js";
import { PostgresAgentRuns, newAgentId, type RunLease } from "./postgres.js";

/** No model, prompt, scripted plan, tool input or executable module is accepted
 * by the production admission API. Later planning stories supply their own driver. */
export async function runInfrastructure(
  runs: PostgresAgentRuns,
  id: string,
  signal: AbortSignal,
): Promise<void> {
  const waitingUntil = Date.now() + 6000;
  let lease = await runs.claim(id);
  while (!lease) {
    const terminal = (
      await runs.pool.query<{ state: string }>("SELECT state FROM agent_runs WHERE id=$1", [id])
    ).rows[0]?.state;
    if (terminal === undefined || ["Completed", "Failed", "Cancelled"].includes(terminal)) return;
    signal.throwIfAborted();
    if (Date.now() >= waitingUntil) throw new AgentError("fenced");
    await pause(signal, 100);
    lease = await runs.claim(id);
  }
  const view = await runs.workerView(lease);
  signal.throwIfAborted();
  if (view.state === "Pending") await runs.move(lease, "Observing");
  signal.throwIfAborted();
  if ((await runs.workerView(lease)).state === "Observing") await runs.move(lease, "Planning");
  signal.throwIfAborted();
  if ((await runs.workerView(lease)).state === "Planning")
    await runs.move(lease, "Failed", "PLANNER_NOT_CONFIGURED");
  else await runs.move(lease, "Failed", "EXECUTION_UNCONFIRMED");
}
/** Shared guarded primitive for controlled ToolExecutor conformance harnesses.
 * Only registered trim/split proposals are supported; no arbitrary external effects.
 * A started intent without an atomic checkpoint is never executed a second time. */
export async function executeAgentTool(
  runs: PostgresAgentRuns,
  lease: RunLease,
  executor: ToolExecutor,
  call: ToolCall,
  signal: AbortSignal,
  recoverConfirmedRejection = false,
): Promise<boolean> {
  const run = await runs.workerView(lease);
  if (
    call.projectId !== run.projectId ||
    call.callerId !== (await runs.workerActor(lease)) ||
    call.resource.kind !== "timeline" ||
    call.resource.id !== run.source?.timelineId
  )
    throw new AgentError("invalid_input");
  signal.throwIfAborted();
  const step = await runs.beginStep(lease, call.name, call.version, call.input);
  if (!step) return false;
  const abort = new AbortController();
  const timer = setInterval(() => {
    void runs.renew(lease).catch(() => abort.abort());
  }, 250);
  try {
    await runs.renew(lease);
    signal.throwIfAborted();
    const result = await executor.executeWithIdentity(
      step.receiptId,
      call,
      AbortSignal.any([signal, abort.signal]),
    );
    signal.throwIfAborted();
    await runs.finishStep(lease, step, {
      output: result.output,
      commands: result.commands,
      durationMs: result.record.durationMs ?? 0,
      costMicros: result.record.costMicros,
    });
    return true;
  } catch (error) {
    if (error instanceof ToolError) {
      if (recoverConfirmedRejection && (await runs.rejectToolAndContinue(lease))) return false;
      if (recoverConfirmedRejection) await runs.failTool(lease);
      else await runs.failTool(lease).catch(() => undefined);
      return false;
    }
    throw error;
  } finally {
    clearInterval(timer);
  }
}

/** Reuses US-129 job admission/retry/lease handling. PG pending rows are the
 * durable outbox: Redis unavailability never loses an accepted AgentRun. */
export async function publishAgentRun(
  runs: PostgresAgentRuns,
  queue: JobQueue,
  id: string,
): Promise<void> {
  const row = (
    await runs.pool.query<{ project_id: string; correlation_id: string }>(
      "SELECT project_id,correlation_id FROM agent_runs WHERE id=$1 AND state NOT IN ('Completed','Failed','Cancelled')",
      [id],
    )
  ).rows[0];
  if (!row) return;
  const input = {
    id,
    queueName: AGENT_QUEUE,
    jobType: AGENT_JOB_TYPE,
    idempotencyKey: `agent.run.v1.${id}`,
    payload: { runId: id, correlationId: row.correlation_id },
    subject: { kind: "project" as const, projectId: projectId(row.project_id) },
    timeoutMs: AGENT_DEADLINE_MS,
    maxAttempts: 3,
    backoffBaseMs: 400,
  };
  await enqueueJob(
    {
      jobs: new PostgresJobRepository(runs.pool),
      queue,
      now: () => instant(BigInt(Date.now())),
      newAttemptId: newAgentId,
      supervisor: {
        async run() {
          throw new AgentError("invalid_input");
        },
      },
    },
    input,
  );
  const stored = await new PostgresJobRepository(runs.pool).findById(jobId(id));
  if (stored?.status === "Running" || stored?.status === "Retrying")
    await queue.enqueue({ ...input, id: jobId(id) });
}
export async function consumeAgentRuns(
  runs: PostgresAgentRuns,
  queue: JobQueue,
  signal: AbortSignal,
  onError: () => void,
): Promise<void> {
  return consumeRuns(runs, queue, signal, onError, runInfrastructure);
}
/** Separate trusted qualification composition. Production main never selects
 * this consumer and no admission payload chooses a driver. */
export async function consumeControlledAgentRuns(
  runs: PostgresAgentRuns,
  queue: JobQueue,
  signal: AbortSignal,
  onError: () => void,
  driver: (runs: PostgresAgentRuns, id: string, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  runs.requireControlledReplay();
  return consumeRuns(runs, queue, signal, onError, driver);
}
async function consumeRuns(
  runs: PostgresAgentRuns,
  queue: JobQueue,
  signal: AbortSignal,
  onError: () => void,
  driver: (runs: PostgresAgentRuns, id: string, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const jobs = new PostgresJobRepository(runs.pool);
  while (!signal.aborted) {
    try {
      for (const id of await runs.pendingIds()) {
        if (signal.aborted) break;
        await runs.settleUndeliverable(id);
        await publishAgentRun(runs, queue, id);
      }
      const result = await runNextJob(
        {
          jobs,
          queue,
          now: () => instant(BigInt(Date.now())),
          newAttemptId: newAgentId,
          supervisor: {
            async run(envelope, _handler, jobSignal) {
              if (
                envelope.jobType !== AGENT_JOB_TYPE ||
                envelope.payload.runId !== envelope.jobId ||
                envelope.subject.kind !== "project"
              )
                throw new AgentError("invalid_input");
              try {
                await driver(runs, envelope.jobId, AbortSignal.any([signal, jobSignal]));
              } catch {
                if (jobSignal.aborted) throw jobSignal.reason;
                throw new Error("agent_runtime_failed");
              }
            },
          },
        },
        AGENT_QUEUE,
        { modulePath: "infrastructure-only", exportName: "runInfrastructure" },
      );
      if (result === "idle") await pause(signal, 200);
    } catch {
      if (!signal.aborted) {
        onError();
        await pause(signal, 500);
      }
    }
  }
}
function pause(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

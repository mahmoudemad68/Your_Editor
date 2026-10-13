import type { Pool } from "pg";
import { instant, createUuidV7 } from "@editagent/domain";
import { randomBytes } from "node:crypto";
import {
  ToolRegistry,
  ToolExecutor,
  registerEditingTools,
  editingToolManifests,
  PostgresToolAuthority,
  PostgresToolAuditRepository,
  PostgresRemoteCallStore,
  QueueToolDispatcher,
  RemoteToolConsumer,
  RemoteToolSupervisor,
} from "@editagent/tool-sdk";
import {
  BullMqJobQueue,
  PostgresJobRepository,
  enqueueJob,
  cancelJob,
  PermanentJobError,
  JobCancelledError,
} from "@editagent/job-queue";
import { EditingTimelines } from "./editing-timelines.js";
import { MediaEditingTool } from "./editing-media-tool.js";
import type { RenderObjects } from "./storage.js";
import { reclaimEditingOutputs } from "./editing-recovery.js";

/** Shared SDK factory: daemon and integration tests use the same production composition root. */
export function createEditingRuntime(
  pool: Pool,
  queue: BullMqJobQueue,
  objects: RenderObjects,
  options: { projectBudgetMicros: number; costMicros: number },
) {
  const timelines = new EditingTimelines(pool),
    authority = new PostgresToolAuthority(pool, (project, id) => timelines.load(project, id));
  const registry = new ToolRegistry();
  registerEditingTools(registry, authority, options.costMicros);
  const audit = new PostgresToolAuditRepository(pool, options.projectBudgetMicros),
    calls = new PostgresRemoteCallStore(pool),
    jobs = new PostgresJobRepository(pool);
  const implementations = new Map(
    editingToolManifests(options.costMicros)
      .slice(2)
      .map((m) => [
        `${m.name}@${m.version}`,
        new MediaEditingTool(
          m.name.slice(8).replaceAll("-", "_") as ConstructorParameters<typeof MediaEditingTool>[0],
          pool,
          authority,
          objects,
          options.costMicros,
        ),
      ]),
  );
  const consumer = new RemoteToolConsumer(
    registry,
    authority,
    calls,
    audit,
    queue,
    implementations,
    "render",
  );
  const supervisor = new RemoteToolSupervisor(
    consumer,
    (code) => new PermanentJobError(code),
    () => new JobCancelledError(),
  );
  const deps = {
    jobs,
    queue,
    supervisor,
    now: () => instant(BigInt(Date.now())),
    newAttemptId: () => createUuidV7(Date.now(), randomBytes(10)),
  };
  const dispatcher = new QueueToolDispatcher(
    jobs,
    { enqueue: (i) => enqueueJob(deps, i), cancel: (id) => cancelJob(deps, id) },
    calls,
    audit,
  );
  return {
    registry,
    audit,
    calls,
    authority,
    timelines,
    deps,
    executor: new ToolExecutor(registry, authority, audit, dispatcher),
    reclaim: (signal: AbortSignal) => reclaimEditingOutputs(pool, objects, signal),
  };
}

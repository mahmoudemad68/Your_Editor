import { randomBytes } from "node:crypto";
import {
  agentTerminal,
  assertAgentTransition,
  createUuidV7,
  Timeline,
  parseCommand,
  applyCommand,
  type AgentState,
  type AgentStopReason,
} from "@editagent/domain";
import { contentHash, jsonValue } from "@editagent/tool-sdk";
import type { Pool, PoolClient } from "pg";
import type { ContextResult } from "./context.js";
import { assertControlledReplayPermit, type ControlledReplayPermit } from "./qualification.js";
import {
  AgentStepEventSchema,
  AgentStepV1Schema,
  AgentExportSchema,
  AgentAuditPageSchema,
  type ModelAuditV1,
  type PlanningStop,
  LoopConfigurationV1Schema,
  EditPlanV1Schema,
  ModelAuditV1Schema,
  type LoopConfigurationV1,
  type EditPlanV1,
} from "@editagent/schemas";
import {
  AgentError,
  AGENT_DEADLINE_MS,
  AGENT_MAX_STEPS,
  assertRun,
  checkedUuid,
  type AgentApi,
  type AgentEvent,
  type AgentRunView,
  type AuditPage,
  type AgentExport,
} from "./contracts.js";

type Row = {
  id: string;
  project_id: string;
  actor_id: string;
  state: AgentState;
  revision: number;
  sequence: number;
  checkpoint: number;
  generation: number;
  stop_reason: AgentStopReason | null;
  source_timeline_id: string | null;
  source_sha256: string | null;
  source_snapshot: unknown;
  lease_owner: string | null;
  lease_until: Date | null;
  correlation_id: string;
  request_correlation_sha256: string;
  created_at_ms: string;
  updated_at_ms: string;
  deadline_at_ms: string;
  runtime_driver: "infrastructure-v1" | "controlled-loop-v1";
  planning_stop_reason: PlanningStop | null;
  tool_attempts: number;
  loop_render_job_id?: string | null;
};
export interface RunLease {
  runId: string;
  owner: string;
  generation: number;
}
export interface StepIntent {
  id: string;
  receiptId: string;
  ordinal: number;
  name: string;
  version: string;
  inputSha256: string;
}
export interface LoopSession {
  configuration: LoopConfigurationV1;
  profile_sha256: string;
  context_snapshot: Extract<ContextResult, { ok: true }> | null;
  plan: EditPlanV1 | null;
  plan_sha256: string | null;
  render_receipt_id: string | null;
  render_job_id: string | null;
  render_outcome: "running" | "succeeded" | "failed" | "unconfirmed" | null;
  render_output: unknown;
}
export const newAgentId = () => createUuidV7(Date.now(), randomBytes(10));
const clockSql = "(extract(epoch FROM clock_timestamp())*1000)::bigint";
function view(row: Row): AgentRunView {
  return assertRun({
    schemaVersion: row.runtime_driver === "controlled-loop-v1" ? "1.1.0" : "1.0.0",
    id: row.id,
    projectId: row.project_id,
    state: row.state,
    revision: row.revision,
    sequence: row.sequence,
    checkpoint: row.checkpoint,
    generation: row.generation,
    stopReason: row.stop_reason,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    deadlineAtMs: Number(row.deadline_at_ms),
    source:
      row.source_timeline_id === null
        ? null
        : { timelineId: row.source_timeline_id, stateSha256: row.source_sha256! },
    runtime:
      row.runtime_driver === "controlled-loop-v1"
        ? { driver: "controlled-loop-v1", planner: "replay_only" }
        : { driver: "infrastructure-v1", planner: "not_configured" },
    ...(row.runtime_driver === "controlled-loop-v1"
      ? {
          planning: {
            schemaVersion: "1.0.0" as const,
            stopReason: row.planning_stop_reason,
            renderJobId: row.loop_render_job_id ?? null,
            toolAttempts: row.tool_attempts,
          },
        }
      : {}),
  });
}
/** PG is the authority for cancellation, lease fences, checkpoints and replay.
 * Transactions share-lock membership and project rows to serialize revocation. */
export class PostgresAgentRuns implements AgentApi {
  constructor(
    readonly pool: Pool,
    private readonly replayPermit?: ControlledReplayPermit,
  ) {}
  requireControlledReplay(): void {
    assertControlledReplayPermit(this.replayPermit);
  }
  private async tx<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const result = await work(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
  private async access(
    db: PoolClient,
    actor: string,
    project: string,
    write = false,
  ): Promise<void> {
    checkedUuid(actor);
    checkedUuid(project);
    const result = await db.query<{ role: string }>(
      `SELECT m.role FROM projects p JOIN project_memberships m ON m.project_id=p.id
   WHERE p.id=$1 AND p.deleted_at IS NULL AND m.user_id=$2 FOR SHARE OF p,m`,
      [project, actor],
    );
    if (!result.rows[0]) throw new AgentError("not_found");
    if (write && !["owner", "editor"].includes(result.rows[0].role))
      throw new AgentError("forbidden");
  }
  private async locked(db: PoolClient, id: string): Promise<Row> {
    const row = (
      await db.query<Row>(
        "SELECT r.*,(SELECT render_job_id FROM agent_loop_sessions WHERE run_id=r.id) AS loop_render_job_id FROM agent_runs r WHERE r.id=$1 FOR UPDATE OF r",
        [checkedUuid(id)],
      )
    ).rows[0];
    if (!row) throw new AgentError("not_found");
    return row;
  }
  private async event(
    db: PoolClient,
    row: Row,
    kind: AgentEvent["kind"],
    tool: AgentEvent["tool"] = null,
    model: ModelAuditV1 | null = null,
  ): Promise<void> {
    if (row.sequence >= 256) throw new AgentError("conflict");
    row.sequence++;
    row.revision++;
    row.updated_at_ms = String(
      (await db.query<{ now: string }>(`SELECT ${clockSql} AS now`)).rows[0]!.now,
    );
    const summaries = {
      admitted: "RUN_ADMITTED",
      transition: "STATE_CHANGED",
      tool_intent: "TOOL_STARTED",
      tool_result: "TOOL_FINISHED",
      recovered: "CHECKPOINT_RESTORED",
      model_intent: "MODEL_STARTED",
      model_result: "MODEL_FINISHED",
      planning_feedback: "PLAN_REJECTED",
      plan_committed: "PLAN_COMMITTED",
      render_intent: "RENDER_STARTED",
      render_result: "RENDER_FINISHED",
    } as const;
    const event: AgentEvent = {
      schemaVersion: row.runtime_driver === "controlled-loop-v1" ? "1.1.0" : "1.0.0",
      id: newAgentId(),
      runId: row.id,
      sequence: row.sequence,
      revision: row.revision,
      state: row.state,
      kind,
      summary: summaries[kind],
      atMs: Number(row.updated_at_ms),
      correlationId: row.correlation_id,
      requestCorrelationSha256: row.request_correlation_sha256,
      stopReason: row.stop_reason,
      tool,
      tokens: model?.receipt
        ? { input: model.receipt.usage.inputTokens, output: model.receipt.usage.outputTokens }
        : null,
      tokenMeasurement: model ? (model.receipt?.usage.source ?? "unavailable") : "not_applicable",
      decision:
        row.runtime_driver !== "controlled-loop-v1"
          ? "no_llm"
          : model
            ? "model"
            : tool
              ? "tool_execution"
              : "runtime",
      ...(row.runtime_driver === "controlled-loop-v1" ? { model } : {}),
    };
    if (!AgentStepEventSchema.safeParse(event).success) throw new AgentError("invalid_input");
    await db.query(
      "INSERT INTO agent_events(id,run_id,sequence,event) VALUES($1,$2,$3,$4::jsonb)",
      [event.id, row.id, row.sequence, JSON.stringify(event)],
    );
    await db.query(
      `UPDATE agent_runs SET state=$2,revision=$3,sequence=$4,checkpoint=$5,generation=$6,stop_reason=$7,
   lease_owner=$8,lease_until=$9,updated_at_ms=$10,tool_attempts=$11 WHERE id=$1`,
      [
        row.id,
        row.state,
        row.revision,
        row.sequence,
        row.checkpoint,
        row.generation,
        row.stop_reason,
        row.lease_owner,
        row.lease_until,
        row.updated_at_ms,
        row.tool_attempts,
      ],
    );
  }
  private async transition(
    db: PoolClient,
    row: Row,
    state: AgentState,
    reason: AgentStopReason | null,
  ): Promise<void> {
    assertAgentTransition(row.state, state, reason);
    row.state = state;
    row.stop_reason = reason;
    if (agentTerminal(state)) {
      row.lease_owner = null;
      row.lease_until = null;
    }
    await this.event(db, row, "transition");
  }
  async start(
    actor: string,
    project: string,
    input: unknown,
    correlationId: string,
  ): Promise<AgentRunView> {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new AgentError("invalid_input");
    const body = input as Record<string, unknown>;
    if (typeof correlationId !== "string" || correlationId.length > 128)
      throw new AgentError("invalid_input");
    if (
      Object.keys(body).sort().join() !== "idempotencyKey" &&
      Object.keys(body).sort().join() !== "idempotencyKey,stateSha256,timelineId"
    )
      throw new AgentError("invalid_input");
    if (
      typeof body.idempotencyKey !== "string" ||
      !/^[a-zA-Z0-9_-]{16,96}$/.test(body.idempotencyKey)
    )
      throw new AgentError("invalid_input");
    if (
      body.timelineId !== undefined &&
      (typeof body.timelineId !== "string" ||
        typeof body.stateSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(body.stateSha256))
    )
      throw new AgentError("invalid_input");
    const key = contentHash(body.idempotencyKey);
    return this.tx(async (db) => {
      await this.access(db, actor, project, true);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `agent-admit:${project}:${actor}:${key}`,
      ]);
      const existing = (
        await db.query<Row>(
          "SELECT r.*,(SELECT render_job_id FROM agent_loop_sessions WHERE run_id=r.id) AS loop_render_job_id FROM agent_runs r WHERE project_id=$1 AND actor_id=$2 AND admission_key=$3",
          [project, actor, key],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.source_timeline_id !== (body.timelineId ?? null) ||
          existing.source_sha256 !== (body.stateSha256 ?? null)
        )
          throw new AgentError("conflict");
        return view(existing);
      }
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `agent-project:${project}`,
      ]);
      const active = await db.query(
        "SELECT id FROM agent_runs WHERE project_id=$1 AND state NOT IN ('Completed','Failed','Cancelled') LIMIT 8",
        [project],
      );
      if (active.rowCount !== null && active.rowCount >= 8) throw new AgentError("conflict");
      let snapshot: unknown = null;
      if (body.timelineId !== undefined) {
        const source = (
          await db.query<{ snapshot: unknown; state_sha256: string }>(
            "SELECT snapshot,state_sha256 FROM editing_timelines WHERE id=$1 AND project_id=$2 FOR SHARE",
            [checkedUuid(body.timelineId as string), project],
          )
        ).rows[0];
        if (!source) throw new AgentError("not_found");
        if (
          source.state_sha256 !== body.stateSha256 ||
          contentHash(source.snapshot) !== source.state_sha256
        )
          throw new AgentError("conflict");
        Timeline.restore(source.snapshot);
        snapshot = source.snapshot;
      }
      const row = (
        await db.query<Row>(
          `INSERT INTO agent_runs(id,project_id,actor_id,admission_key,source_timeline_id,source_sha256,source_snapshot,correlation_id,request_correlation_sha256,created_at_ms,updated_at_ms,deadline_at_ms)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$10,${clockSql},${clockSql},${clockSql}+$9) RETURNING *`,
          [
            newAgentId(),
            project,
            actor,
            key,
            body.timelineId ?? null,
            body.stateSha256 ?? null,
            snapshot === null ? null : JSON.stringify(snapshot),
            newAgentId(),
            AGENT_DEADLINE_MS,
            contentHash(correlationId),
          ],
        )
      ).rows[0]!;
      await this.event(db, row, "admitted");
      return view(row);
    });
  }
  async get(actor: string, project: string, id: string): Promise<AgentRunView> {
    return this.tx(async (db) => {
      await this.access(db, actor, project);
      const row = await this.locked(db, id);
      if (row.project_id !== project) throw new AgentError("not_found");
      return view(row);
    });
  }
  async cancel(actor: string, project: string, id: string): Promise<AgentRunView> {
    return this.tx(async (db) => {
      await this.access(db, actor, project, true);
      const row = await this.locked(db, id);
      if (row.project_id !== project) throw new AgentError("not_found");
      if (!agentTerminal(row.state)) {
        await this.unconfirmedStep(db, row);
        await this.unconfirmedPlanning(db, row);
        row.generation++;
        await this.transition(db, row, "Cancelled", "CANCELLED");
        await db.query(
          `UPDATE jobs SET status='Cancelled',failure_reason='cancelled',updated_at=${clockSql} WHERE id=$1 AND job_type='agent.run.v1' AND status NOT IN ('Completed','Failed','Cancelled')`,
          [row.id],
        );
      }
      return view(row);
    });
  }
  async claim(id: string, owner = newAgentId()): Promise<RunLease | null> {
    return this.tx(async (db) => {
      const row = await this.locked(db, id);
      if (agentTerminal(row.state)) return null;
      try {
        await this.access(db, row.actor_id, row.project_id, true);
      } catch (error) {
        if (!(error instanceof AgentError)) throw error;
        await this.unconfirmedStep(db, row);
        await this.unconfirmedPlanning(db, row);
        await this.transition(db, row, "Failed", "ACCESS_REVOKED");
        return null;
      }
      const now = Number(
        (await db.query<{ now: string }>(`SELECT ${clockSql} AS now`)).rows[0]!.now,
      );
      if (Number(row.deadline_at_ms) <= now) {
        await this.unconfirmedStep(db, row);
        await this.unconfirmedPlanning(db, row);
        await this.transition(db, row, "Failed", "DEADLINE_EXCEEDED");
        return null;
      }
      if (row.lease_until !== null && row.lease_until.getTime() > now) return null;
      row.generation++;
      row.lease_owner = checkedUuid(owner);
      row.lease_until = new Date(now + 5000);
      await this.event(db, row, "recovered");
      return { runId: id, owner, generation: row.generation };
    });
  }
  private async fenced(db: PoolClient, lease: RunLease): Promise<Row> {
    const row = await this.locked(db, lease.runId);
    const now = Number((await db.query<{ now: string }>(`SELECT ${clockSql} AS now`)).rows[0]!.now);
    if (
      agentTerminal(row.state) ||
      row.generation !== lease.generation ||
      row.lease_owner !== lease.owner ||
      row.lease_until === null ||
      row.lease_until.getTime() <= now ||
      Number(row.deadline_at_ms) <= now
    )
      throw new AgentError("fenced");
    await this.access(db, row.actor_id, row.project_id, true);
    return row;
  }
  async renew(lease: RunLease): Promise<void> {
    await this.tx(async (db) => {
      await this.fenced(db, lease);
      await db.query(
        "UPDATE agent_runs SET lease_until=clock_timestamp()+interval '5 seconds' WHERE id=$1",
        [lease.runId],
      );
    });
  }
  async move(
    lease: RunLease,
    state: AgentState,
    reason: AgentStopReason | null = null,
  ): Promise<void> {
    await this.tx(async (db) => {
      const row = await this.fenced(db, lease);
      if (state === "Evaluating" || state === "Completed") {
        const unfinished = await db.query(
          row.runtime_driver === "controlled-loop-v1"
            ? "SELECT id FROM agent_steps WHERE run_id=$1 AND outcome IN ('running','unconfirmed') LIMIT 1"
            : "SELECT id FROM agent_steps WHERE run_id=$1 AND outcome<>'succeeded' LIMIT 1",
          [row.id],
        );
        if (unfinished.rowCount !== 0) throw new AgentError("conflict");
      }
      if (state === "Failed" || state === "Cancelled") {
        await this.unconfirmedStep(db, row);
        await this.unconfirmedPlanning(db, row);
      }
      await this.transition(db, row, state, reason);
    });
  }
  async workerView(lease: RunLease): Promise<AgentRunView> {
    return this.tx(async (db) => view(await this.fenced(db, lease)));
  }
  async workerActor(lease: RunLease): Promise<string> {
    return this.tx(async (db) => (await this.fenced(db, lease)).actor_id);
  }
  async originalTimeline(lease: RunLease): Promise<Timeline> {
    return this.tx(async (db) => {
      const row = await this.fenced(db, lease);
      if (!row.source_snapshot || contentHash(row.source_snapshot) !== row.source_sha256)
        throw new AgentError("conflict");
      return Timeline.restore(row.source_snapshot);
    });
  }
  /** Internal isolated-qualification composition only; never called by API
   * admission or production main. It cannot enable a hosted/live planner. */
  async enableControlledReplay(
    actor: string,
    project: string,
    id: string,
    input: unknown,
    profileSha256: string,
  ): Promise<void> {
    this.requireControlledReplay();
    if (!/^[a-f0-9]{64}$/.test(profileSha256)) throw new AgentError("forbidden");
    const configuration = LoopConfigurationV1Schema.parse(input);
    await this.tx(async (db) => {
      await this.access(db, actor, project, true);
      const row = await this.locked(db, id);
      if (row.project_id !== project || row.actor_id !== actor) throw new AgentError("not_found");
      if (row.state !== "Pending" || row.source_snapshot === null || row.generation !== 0)
        throw new AgentError("conflict");
      const existing = (
        await db.query<{ configuration: unknown; profile_sha256: string }>(
          "SELECT configuration,profile_sha256 FROM agent_loop_sessions WHERE run_id=$1",
          [id],
        )
      ).rows[0];
      if (existing) {
        if (
          contentHash(existing.configuration) !== contentHash(configuration) ||
          existing.profile_sha256 !== profileSha256
        )
          throw new AgentError("conflict");
        return;
      }
      await db.query(
        "INSERT INTO agent_loop_sessions(run_id,schema_version,configuration,profile_sha256) VALUES($1,'1.0.0',$2::jsonb,$3)",
        [id, JSON.stringify(configuration), profileSha256],
      );
      await db.query("UPDATE agent_runs SET runtime_driver='controlled-loop-v1' WHERE id=$1", [id]);
    });
  }
  async loopSession(lease: RunLease): Promise<LoopSession> {
    return this.tx(async (db) => {
      const row = await this.fenced(db, lease);
      if (row.runtime_driver !== "controlled-loop-v1") throw new AgentError("forbidden");
      const result = (
        await db.query<LoopSession>("SELECT * FROM agent_loop_sessions WHERE run_id=$1", [row.id])
      ).rows[0];
      if (!result) throw new AgentError("conflict");
      LoopConfigurationV1Schema.parse(result.configuration);
      if (result.plan !== null) EditPlanV1Schema.parse(result.plan);
      return result;
    });
  }
  async freezeLoopContext(
    lease: RunLease,
    input: Extract<ContextResult, { ok: true }>,
  ): Promise<void> {
    const snapshot = jsonValue(input);
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 1048576)
      throw new AgentError("invalid_input");
    await this.tx(async (db) => {
      const row = await this.fenced(db, lease);
      if (
        row.runtime_driver !== "controlled-loop-v1" ||
        !["Observing", "Planning"].includes(row.state)
      )
        throw new AgentError("conflict");
      const result = await db.query(
        "UPDATE agent_loop_sessions SET context_snapshot=$2::jsonb WHERE run_id=$1 AND context_snapshot IS NULL",
        [row.id, JSON.stringify(snapshot)],
      );
      if (result.rowCount !== 1) throw new AgentError("conflict");
    });
  }
  async planningStop(lease: RunLease, code: PlanningStop): Promise<void> {
    await this.tx(async (db) => {
      const row = await this.fenced(db, lease);
      if (row.runtime_driver !== "controlled-loop-v1") throw new AgentError("forbidden");
      row.planning_stop_reason = code;
      await db.query("UPDATE agent_runs SET planning_stop_reason=$2 WHERE id=$1", [row.id, code]);
      await this.unconfirmedPlanning(db, row);
      await this.unconfirmedStep(db, row);
      await this.transition(
        db,
        row,
        "Failed",
        code.includes("UNCONFIRMED") ? "EXECUTION_UNCONFIRMED" : "INTERNAL",
      );
    });
  }
  async planningFeedback(lease: RunLease): Promise<void> {
    await this.tx(async (db) => {
      const row = await this.fenced(db, lease);
      if (row.runtime_driver !== "controlled-loop-v1") throw new AgentError("forbidden");
      await this.event(db, row, "planning_feedback");
    });
  }
  async beginModelCall(lease: RunLease, model: ModelAuditV1): Promise<void> {
    const audit = ModelAuditV1Schema.parse(model);
    if (audit.outcome !== "running" || audit.receipt !== null || audit.failure !== null)
      throw new AgentError("invalid_input");
    await this.tx(async (db) => {
      const row = await this.fenced(db, lease);
      if (
        row.runtime_driver !== "controlled-loop-v1" ||
        !["Planning", "Executing"].includes(row.state)
      )
        throw new AgentError("forbidden");
      const stored = (
        await db.query<{
          context_snapshot: LoopSession["context_snapshot"];
          profile_sha256: string;
        }>("SELECT context_snapshot,profile_sha256 FROM agent_loop_sessions WHERE run_id=$1", [
          row.id,
        ])
      ).rows[0];
      if (
        !stored?.context_snapshot ||
        stored.profile_sha256 !== audit.providerProfile.profileSha256 ||
        stored.context_snapshot.sha256 !== audit.contextSha256 ||
        stored.context_snapshot.summary.templateHash !== audit.templateHash ||
        stored.context_snapshot.summary.promptId !== audit.promptId ||
        stored.context_snapshot.summary.promptVersion !== audit.promptVersion
      )
        throw new AgentError("conflict");
      await db.query(
        "INSERT INTO agent_model_calls(id,run_id,ordinal,generation,request_sha256,outcome,audit) VALUES($1,$2,$3,$4,$5,'running',$6::jsonb)",
        [
          audit.callId,
          row.id,
          audit.ordinal,
          row.generation,
          audit.requestSha256,
          JSON.stringify(audit),
        ],
      );
      await this.event(db, row, "model_intent", null, audit);
    });
  }
  async finishModelCall(
    lease: RunLease,
    input: ModelAuditV1,
    validatedResult: unknown = null,
  ): Promise<void> {
    const audit = ModelAuditV1Schema.parse(input);
    if (audit.outcome === "running") throw new AgentError("invalid_input");
    if (
      (audit.outcome === "succeeded" && (!audit.receipt || audit.failure !== null)) ||
      (audit.outcome === "failed" && audit.failure === null) ||
      (audit.outcome === "unconfirmed" && (audit.receipt !== null || audit.failure === null))
    )
      throw new AgentError("invalid_input");
    const result = jsonValue(validatedResult);
    if (Buffer.byteLength(JSON.stringify(result)) > 65536) throw new AgentError("invalid_input");
    await this.tx(async (db) => {
      const row = await this.fenced(db, lease);
      const current = (
        await db.query<{ audit: ModelAuditV1 }>(
          "SELECT audit FROM agent_model_calls WHERE id=$1 AND run_id=$2 AND generation=$3 AND outcome='running' FOR UPDATE",
          [audit.callId, row.id, lease.generation],
        )
      ).rows[0];
      if (
        !current ||
        contentHash({
          ...current.audit,
          outcome: audit.outcome,
          receipt: audit.receipt,
          failure: audit.failure,
        }) !== contentHash(audit)
      )
        throw new AgentError("fenced");
      if (audit.receipt && audit.receipt.requestSha256 !== audit.requestSha256)
        throw new AgentError("invalid_input");
      await db.query(
        "UPDATE agent_model_calls SET outcome=$2,audit=$3::jsonb,validated_result=$4::jsonb WHERE id=$1",
        [audit.callId, audit.outcome, JSON.stringify(audit), JSON.stringify(result)],
      );
      await this.event(db, row, "model_result", null, audit);
    });
  }
  async modelCalls(lease: RunLease): Promise<ModelAuditV1[]> {
    return this.tx(async (db) => {
      await this.fenced(db, lease);
      return (
        await db.query<{ audit: ModelAuditV1 }>(
          "SELECT audit FROM agent_model_calls WHERE run_id=$1 ORDER BY ordinal",
          [lease.runId],
        )
      ).rows.map((x) => ModelAuditV1Schema.parse(x.audit));
    });
  }
  async validatedModelResult(lease: RunLease, requestSha256: string): Promise<unknown | null> {
    return this.tx(async (db) => {
      await this.fenced(db, lease);
      return (
        (
          await db.query<{ validated_result: unknown }>(
            "SELECT validated_result FROM agent_model_calls WHERE run_id=$1 AND request_sha256=$2 AND outcome='succeeded' AND validated_result IS NOT NULL ORDER BY ordinal DESC LIMIT 1",
            [lease.runId, requestSha256],
          )
        ).rows[0]?.validated_result ?? null
      );
    });
  }
  async commitPlan(lease: RunLease, input: unknown): Promise<void> {
    const plan = EditPlanV1Schema.parse(input);
    await this.tx(async (db) => {
      const row = await this.fenced(db, lease);
      if (
        row.state !== "Planning" ||
        plan.projectId !== row.project_id ||
        plan.timelineId !== row.source_timeline_id ||
        plan.sourceSha256 !== row.source_sha256
      )
        throw new AgentError("invalid_input");
      const result = await db.query(
        "UPDATE agent_loop_sessions SET plan=$2::jsonb,plan_sha256=$3 WHERE run_id=$1 AND plan IS NULL",
        [row.id, JSON.stringify(plan), contentHash(plan)],
      );
      if (result.rowCount !== 1) throw new AgentError("conflict");
      await this.event(db, row, "plan_committed");
    });
  }
  async renderAdmission<T>(
    lease: RunLease,
    work: (receiptId: string, actor: string, timeline: Timeline) => Promise<T>,
  ): Promise<T> {
    return this.tx(async (db) => {
      const row = await this.fenced(db, lease);
      if (row.state !== "Rendering") throw new AgentError("conflict");
      const session = (
        await db.query<LoopSession>(
          "SELECT * FROM agent_loop_sessions WHERE run_id=$1 FOR UPDATE",
          [row.id],
        )
      ).rows[0];
      if (!session?.render_receipt_id || session.render_outcome !== "running")
        throw new AgentError("conflict");
      const current = (
        await db.query<{ snapshot: unknown; state_sha256: string }>(
          "SELECT snapshot,state_sha256 FROM editing_timelines WHERE id=$1 AND project_id=$2 FOR SHARE",
          [row.source_timeline_id, row.project_id],
        )
      ).rows[0];
      if (
        !current ||
        current.state_sha256 !== (await this.expectedBasis(db, row)) ||
        contentHash(current.snapshot) !== current.state_sha256
      )
        throw new AgentError("fenced");
      const result = await work(
        session.render_receipt_id,
        row.actor_id,
        Timeline.restore(current.snapshot),
      );
      await this.fenced(db, lease);
      return result;
    });
  }
  async beginRender(lease: RunLease): Promise<{ receiptId: string; resumed: boolean }> {
    return this.tx(async (db) => {
      const row = await this.fenced(db, lease);
      if (row.state !== "Rendering") throw new AgentError("conflict");
      const session = (
        await db.query<LoopSession>(
          "SELECT * FROM agent_loop_sessions WHERE run_id=$1 FOR UPDATE",
          [row.id],
        )
      ).rows[0];
      if (!session) throw new AgentError("conflict");
      if (session.render_receipt_id) return { receiptId: session.render_receipt_id, resumed: true };
      const receiptId = newAgentId();
      await db.query(
        "UPDATE agent_loop_sessions SET render_receipt_id=$2,render_outcome='running' WHERE run_id=$1",
        [row.id, receiptId],
      );
      await this.event(db, row, "render_intent");
      return { receiptId, resumed: false };
    });
  }
  async attachRender(lease: RunLease, id: string): Promise<void> {
    await this.tx(async (db) => {
      const row = await this.fenced(db, lease);
      const result = await db.query(
        "UPDATE agent_loop_sessions SET render_job_id=$2 WHERE run_id=$1 AND render_outcome='running' AND (render_job_id IS NULL OR render_job_id=$2)",
        [row.id, checkedUuid(id)],
      );
      if (result.rowCount !== 1) throw new AgentError("fenced");
    });
  }
  async finishRender(
    lease: RunLease,
    output: {
      jobId: string;
      artifactSha256: string;
      durationUs: string;
      videoFrames: number;
      audioPresent: boolean;
    },
  ): Promise<void> {
    if (
      !/^[a-f0-9]{64}$/.test(output.artifactSha256) ||
      !/^\d{1,10}$/.test(output.durationUs) ||
      !Number.isSafeInteger(output.videoFrames) ||
      output.videoFrames < 1
    )
      throw new AgentError("invalid_input");
    await this.tx(async (db) => {
      const row = await this.fenced(db, lease);
      if (row.state !== "Rendering") throw new AgentError("conflict");
      const result = await db.query(
        "UPDATE agent_loop_sessions SET render_outcome='succeeded',render_output=$3::jsonb WHERE run_id=$1 AND render_job_id=$2 AND render_outcome='running'",
        [row.id, checkedUuid(output.jobId), JSON.stringify(output)],
      );
      if (result.rowCount !== 1) throw new AgentError("fenced");
      await this.event(db, row, "render_result");
    });
  }
  async beginStep(
    lease: RunLease,
    name: string,
    version: string,
    input: unknown,
  ): Promise<StepIntent | null> {
    if (!/^editing\.(trim-video|split-video)$/.test(name) || version !== "1.0.0")
      throw new AgentError("invalid_input");
    const inputSha256 = contentHash(input);
    return this.tx(async (db) => {
      const row = await this.fenced(db, lease);
      if (row.state !== "Executing") throw new AgentError("conflict");
      const current = (
        await db.query<{ state_sha256: string }>(
          "SELECT state_sha256 FROM editing_timelines WHERE id=$1 AND project_id=$2",
          [row.source_timeline_id, row.project_id],
        )
      ).rows[0];
      if (!current || current.state_sha256 !== (await this.expectedBasis(db, row))) {
        await this.unconfirmedStep(db, row);
        await this.transition(db, row, "Failed", "STALE_SOURCE");
        return null;
      }
      const ordinal =
        row.runtime_driver === "controlled-loop-v1" ? row.tool_attempts : row.checkpoint;
      if (ordinal >= AGENT_MAX_STEPS) {
        await this.transition(db, row, "Failed", "STEP_LIMIT");
        return null;
      }
      const previous = (
        await db.query("SELECT id FROM agent_steps WHERE run_id=$1 AND ordinal=$2", [
          row.id,
          ordinal,
        ])
      ).rows[0];
      if (previous) {
        await this.unconfirmedStep(db, row);
        await this.transition(db, row, "Failed", "EXECUTION_UNCONFIRMED");
        return null;
      }
      const step: StepIntent = {
        id: newAgentId(),
        receiptId: newAgentId(),
        ordinal,
        name,
        version,
        inputSha256,
      };
      if (!AgentStepV1Schema.safeParse({ schemaVersion: "1.0.0", ...step, runId: row.id }).success)
        throw new AgentError("invalid_input");
      await db.query(
        `INSERT INTO agent_steps(id,run_id,ordinal,receipt_id,tool_name,tool_version,input_sha256,outcome,generation,created_at_ms) VALUES($1,$2,$3,$4,$5,$6,$7,'running',$8,${clockSql})`,
        [step.id, row.id, step.ordinal, step.receiptId, name, version, inputSha256, row.generation],
      );
      await this.event(db, row, "tool_intent", {
        name,
        version,
        inputSha256,
        outputSha256: null,
        receiptId: step.receiptId,
        outcome: "running",
        durationMs: null,
        costMicros: null,
      });
      return step;
    });
  }
  /** Tool proposals have no timeline effect until this atomic, authorized fenced
   * transaction commits BOTH the canonical timeline and its causal receipt. */
  async finishStep(
    lease: RunLease,
    step: StepIntent,
    result: {
      output: unknown;
      commands: readonly unknown[];
      durationMs: number;
      costMicros: number;
    },
  ): Promise<void> {
    await this.tx(async (db) => {
      const row = await this.fenced(db, lease);
      const intent = (
        await db.query<{ receipt_id: string; input_sha256: string; tool_name: string }>(
          "SELECT * FROM agent_steps WHERE id=$1 AND run_id=$2 AND ordinal=$3 AND generation=$4 AND outcome='running' FOR UPDATE",
          [
            step.id,
            row.id,
            row.runtime_driver === "controlled-loop-v1" ? row.tool_attempts : row.checkpoint,
            lease.generation,
          ],
        )
      ).rows[0];
      if (
        !intent ||
        intent.receipt_id !== step.receiptId ||
        intent.input_sha256 !== step.inputSha256 ||
        intent.tool_name !== step.name
      )
        throw new AgentError("fenced");
      const receipt = (
        await db.query<{
          outcome: string;
          project_id: string;
          caller_id: string;
          tool_name: string;
          tool_version: string;
          input_hash: string;
          duration_ms: number;
          cost_micros: string;
        }>(
          "SELECT *, (finished_at_ms-started_at_ms)::integer AS duration_ms FROM tool_executions WHERE id=$1 FOR SHARE",
          [step.receiptId],
        )
      ).rows[0];
      if (
        !receipt ||
        receipt.outcome !== "succeeded" ||
        receipt.project_id !== row.project_id ||
        receipt.caller_id !== row.actor_id ||
        receipt.tool_name !== step.name ||
        receipt.tool_version !== step.version ||
        receipt.input_hash !== step.inputSha256
      )
        throw new AgentError("conflict");
      const output = result.output as { basisSha256?: unknown };
      if (
        !row.source_timeline_id ||
        !output ||
        typeof output.basisSha256 !== "string" ||
        result.commands.length !== 1
      )
        throw new AgentError("invalid_input");
      const stored = (
        await db.query<{ snapshot: unknown; state_sha256: string }>(
          "SELECT snapshot,state_sha256 FROM editing_timelines WHERE id=$1 AND project_id=$2 FOR UPDATE",
          [row.source_timeline_id, row.project_id],
        )
      ).rows[0];
      if (
        !stored ||
        stored.state_sha256 !== output.basisSha256 ||
        stored.state_sha256 !== (await this.expectedBasis(db, row)) ||
        contentHash(stored.snapshot) !== stored.state_sha256
      )
        throw new AgentError("conflict");
      let timeline = Timeline.restore(stored.snapshot);
      const commands = result.commands.map(parseCommand);
      for (const command of commands) {
        if (
          command.timelineId !== row.source_timeline_id ||
          (step.name === "editing.trim-video"
            ? command.type !== "TrimClip"
            : command.type !== "SplitClip")
        )
          throw new AgentError("invalid_input");
        timeline = applyCommand(timeline, command).timeline;
      }
      const snapshot = timeline.toSnapshot(),
        hash = contentHash(snapshot);
      // Re-evaluate clock after any lock waits, immediately before effect admission.
      await this.fenced(db, lease);
      await db.query(
        "SELECT set_config('editagent.agent_run',$1,true),set_config('editagent.agent_owner',$2,true),set_config('editagent.agent_generation',$3,true)",
        [row.id, lease.owner, String(lease.generation)],
      );
      await db.query(
        "UPDATE editing_timelines SET snapshot=$2::jsonb,state_sha256=$3 WHERE id=$1",
        [row.source_timeline_id, JSON.stringify(snapshot), hash],
      );
      const outputHash = contentHash(result.output);
      await db.query(
        `UPDATE agent_steps SET outcome='succeeded',output_sha256=$2,duration_ms=$3,cost_micros=$4,basis_sha256=$5,result_sha256=$6,commands=$7::jsonb,finished_at_ms=${clockSql} WHERE id=$1`,
        [
          step.id,
          outputHash,
          receipt.duration_ms,
          receipt.cost_micros,
          stored.state_sha256,
          hash,
          JSON.stringify(commands),
        ],
      );
      row.checkpoint++;
      if (row.runtime_driver === "controlled-loop-v1") row.tool_attempts++;
      await this.event(db, row, "tool_result", {
        name: step.name,
        version: step.version,
        inputSha256: step.inputSha256,
        outputSha256: outputHash,
        receiptId: step.receiptId,
        outcome: "succeeded",
        durationMs: receipt.duration_ms,
        costMicros: Number(receipt.cost_micros),
      });
    });
  }
  private async expectedBasis(db: PoolClient, row: Row): Promise<string | null> {
    if (row.checkpoint === 0) return row.source_sha256;
    return (
      (
        await db.query<{ result_sha256: string }>(
          "SELECT result_sha256 FROM agent_steps WHERE run_id=$1 AND outcome='succeeded' ORDER BY ordinal DESC LIMIT 1",
          [row.id],
        )
      ).rows[0]?.result_sha256 ?? null
    );
  }
  private async unconfirmedPlanning(db: PoolClient, row: Row): Promise<void> {
    if (row.runtime_driver !== "controlled-loop-v1") return;
    const pending = (
      await db.query<{ id: string; audit: ModelAuditV1 }>(
        "SELECT id,audit FROM agent_model_calls WHERE run_id=$1 AND outcome='running' FOR UPDATE",
        [row.id],
      )
    ).rows;
    for (const p of pending) {
      const audit: ModelAuditV1 = {
        ...p.audit,
        outcome: "unconfirmed",
        failure: "transport_unknown",
      };
      await db.query(
        "UPDATE agent_model_calls SET outcome='unconfirmed',audit=$2::jsonb WHERE id=$1",
        [p.id, JSON.stringify(audit)],
      );
      await this.event(db, row, "model_result", null, audit);
    }
    const render = await db.query(
      "UPDATE agent_loop_sessions SET render_outcome='unconfirmed' WHERE run_id=$1 AND render_outcome='running'",
      [row.id],
    );
    if (render.rowCount === 1) await this.event(db, row, "render_result");
  }
  private async unconfirmedStep(db: PoolClient, row: Row): Promise<void> {
    const intent = (
      await db.query<{
        id: string;
        receipt_id: string;
        tool_name: string;
        tool_version: string;
        input_sha256: string;
      }>(
        "SELECT * FROM agent_steps WHERE run_id=$1 AND ordinal=$2 AND outcome='running' FOR UPDATE",
        [row.id, row.runtime_driver === "controlled-loop-v1" ? row.tool_attempts : row.checkpoint],
      )
    ).rows[0];
    if (!intent) return;
    const receipt = (
      await db.query<{
        outcome: string;
        duration_ms: number | null;
        cost_micros: string;
        cost_basis: string;
      }>(
        "SELECT outcome,(finished_at_ms-started_at_ms)::integer AS duration_ms,cost_micros,cost_basis FROM tool_executions WHERE id=$1",
        [intent.receipt_id],
      )
    ).rows[0];
    const outcome =
      receipt && !["running", "succeeded"].includes(receipt.outcome) ? "failed" : "unconfirmed";
    const duration = receipt?.duration_ms ?? null,
      cost = receipt?.cost_basis === "actual" ? Number(receipt.cost_micros) : null;
    await db.query(
      `UPDATE agent_steps SET outcome=$2,duration_ms=$3,cost_micros=$4,finished_at_ms=${clockSql} WHERE id=$1`,
      [intent.id, outcome, duration, cost],
    );
    await this.event(db, row, "tool_result", {
      name: intent.tool_name,
      version: intent.tool_version,
      inputSha256: intent.input_sha256,
      outputSha256: null,
      receiptId: intent.receipt_id,
      outcome,
      durationMs: duration,
      costMicros: cost,
    });
  }
  async failTool(lease: RunLease): Promise<void> {
    await this.tx(async (db) => {
      const row = await this.fenced(db, lease);
      await this.unconfirmedStep(db, row);
      await this.unconfirmedPlanning(db, row);
      await this.transition(db, row, "Failed", "TOOL_FAILED");
    });
  }
  /** Only confirmed failed/rejected, cleaned-up trim/split proposals may be
   * retried with a NEW receipt. Successful or uncertain effects never qualify. */
  async rejectToolAndContinue(lease: RunLease): Promise<boolean> {
    return this.tx(async (db) => {
      const row = await this.fenced(db, lease);
      if (row.runtime_driver !== "controlled-loop-v1" || row.state !== "Executing") return false;
      const receipt = (
        await db.query<{ outcome: string; cleanup_status: string }>(
          `SELECT e.outcome,e.cleanup_status FROM agent_steps s JOIN tool_executions e ON e.id=s.receipt_id
        WHERE s.run_id=$1 AND s.ordinal=$2 AND s.outcome='running' AND e.outcome IN ('failed','rejected')
        AND e.cleanup_status IN ('not_required','succeeded') FOR SHARE OF e`,
          [row.id, row.tool_attempts],
        )
      ).rows[0];
      if (!receipt) return false;
      await this.unconfirmedStep(db, row);
      row.tool_attempts++;
      await this.event(db, row, "planning_feedback");
      return true;
    });
  }
  async pendingIds(): Promise<string[]> {
    return (
      await this.pool.query<{ id: string }>(
        "SELECT id FROM agent_runs WHERE state NOT IN ('Completed','Failed','Cancelled') ORDER BY created_at_ms,id LIMIT 64",
      )
    ).rows.map((r) => r.id);
  }
  async settleUndeliverable(id: string): Promise<void> {
    await this.tx(async (db) => {
      const row = await this.locked(db, id);
      if (agentTerminal(row.state)) return;
      const now = Number(
        (await db.query<{ now: string }>(`SELECT ${clockSql} AS now`)).rows[0]!.now,
      );
      if (row.lease_until !== null && row.lease_until.getTime() > now) return;
      const job = (
        await db.query<{ status: string }>(
          "SELECT status FROM jobs WHERE id=$1 AND job_type='agent.run.v1'",
          [id],
        )
      ).rows[0];
      if (Number(row.deadline_at_ms) <= now) {
        await this.unconfirmedStep(db, row);
        await this.unconfirmedPlanning(db, row);
        await this.transition(db, row, "Failed", "DEADLINE_EXCEEDED");
      } else if (job?.status === "Failed" || job?.status === "Cancelled") {
        await this.unconfirmedStep(db, row);
        await this.unconfirmedPlanning(db, row);
        await this.transition(
          db,
          row,
          job.status === "Cancelled" ? "Cancelled" : "Failed",
          job.status === "Cancelled" ? "CANCELLED" : "INTERNAL",
        );
      }
    });
  }
  async events(actor: string, project: string, id: string, after?: string): Promise<AgentEvent[]> {
    return this.tx(async (db) => {
      await this.access(db, actor, project);
      const row = await this.locked(db, id);
      if (row.project_id !== project) throw new AgentError("not_found");
      let sequence = 0;
      if (after !== undefined) {
        const match = /^([1-9][0-9]{0,2})\.([a-f0-9-]{36})$/.exec(after);
        if (!match) throw new AgentError("invalid_input");
        sequence = Number(match[1]);
        const anchor = await db.query(
          "SELECT id FROM agent_events WHERE run_id=$1 AND sequence=$2 AND id=$3",
          [id, sequence, checkedUuid(match[2]!)],
        );
        if (anchor.rowCount !== 1) throw new AgentError("invalid_input");
      }
      return (
        await db.query<{ event: AgentEvent }>(
          "SELECT event FROM agent_events WHERE run_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 32",
          [id, sequence],
        )
      ).rows.map((r) => r.event);
    });
  }
  async audit(
    actor: string,
    project: string,
    id: string,
    cursor?: string,
    limit = 50,
  ): Promise<AuditPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new AgentError("invalid_input");
    return this.tx(async (db) => {
      await this.access(db, actor, project);
      const row = await this.locked(db, id);
      if (row.project_id !== project) throw new AgentError("not_found");
      let after = 0,
        through = row.sequence;
      if (cursor !== undefined) {
        if (cursor.length > 220 || !/^[a-zA-Z0-9_-]+$/.test(cursor))
          throw new AgentError("invalid_input");
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        } catch {
          throw new AgentError("invalid_input");
        }
        if (
          !Array.isArray(parsed) ||
          parsed.length !== 5 ||
          parsed[0] !== id ||
          !Number.isSafeInteger(parsed[1]) ||
          !Number.isSafeInteger(parsed[3]) ||
          parsed[1] < 1 ||
          parsed[1] > parsed[3] ||
          parsed[3] > row.sequence
        )
          throw new AgentError("invalid_input");
        const anchors = await db.query(
          "SELECT id,sequence FROM agent_events WHERE run_id=$1 AND ((sequence=$2 AND id=$3) OR (sequence=$4 AND id=$5))",
          [id, parsed[1], checkedUuid(parsed[2]), parsed[3], checkedUuid(parsed[4])],
        );
        if (anchors.rowCount !== (parsed[1] === parsed[3] ? 1 : 2))
          throw new AgentError("invalid_input");
        after = parsed[1];
        through = parsed[3];
      }
      const events = (
        await db.query<{ event: AgentEvent }>(
          "SELECT event FROM agent_events WHERE run_id=$1 AND sequence>$2 AND sequence<=$3 ORDER BY sequence LIMIT $4",
          [id, after, through, limit],
        )
      ).rows.map((r) => r.event);
      const last = events.at(-1);
      let nextCursor: string | null = null;
      if (last && last.sequence < through) {
        const end = (
          await db.query<{ id: string }>(
            "SELECT id FROM agent_events WHERE run_id=$1 AND sequence=$2",
            [id, through],
          )
        ).rows[0]!;
        nextCursor = Buffer.from(
          JSON.stringify([id, last.sequence, last.id, through, end.id]),
        ).toString("base64url");
      }
      const page: AuditPage = {
        schemaVersion: row.runtime_driver === "controlled-loop-v1" ? "1.1.0" : "1.0.0",
        run: view(row),
        events,
        nextCursor,
        throughSequence: through,
      };
      if (!AgentAuditPageSchema.safeParse(page).success)
        throw new Error("agent_audit_contract_invalid");
      return page;
    });
  }
  async export(
    actor: string,
    project: string,
    id: string,
    cursor?: string,
    limit = 50,
  ): Promise<AgentExport> {
    const page = await this.audit(actor, project, id, cursor, limit);
    return this.tx(async (db) => {
      await this.access(db, actor, project);
      const receipts = page.events
        .filter((e) => e.kind === "tool_result" && e.tool?.outcome === "succeeded")
        .map((e) => e.tool!.receiptId);
      const rows = (
        await db.query<{
          id: string;
          receipt_id: string;
          basis_sha256: string;
          result_sha256: string;
          commands: unknown[];
        }>(
          "SELECT * FROM agent_steps WHERE run_id=$1 AND receipt_id=ANY($2::uuid[]) AND outcome='succeeded' ORDER BY ordinal",
          [id, receipts],
        )
      ).rows;
      const result: AgentExport = {
        ...page,
        replay: {
          mode: "apply_commands_to_original_snapshot_only",
          source: page.run.source,
          commands: rows.map((r) => ({
            stepId: r.id,
            receiptId: r.receipt_id,
            basisSha256: r.basis_sha256,
            resultSha256: r.result_sha256,
            commands: r.commands.map(parseCommand),
          })),
          effects: "never_reexecute_tools",
        },
      };
      if (!AgentExportSchema.safeParse(result).success)
        throw new Error("agent_export_contract_invalid");
      return result;
    });
  }
}

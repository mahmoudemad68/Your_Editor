import { type Pool } from "pg";
import { type Timeline } from "@editagent/domain";
import { ToolError, safeErrorCode, checkedId } from "../validation.js";
import {
  type ExecutionRecord,
  type ExecutionOutcome,
  type ToolAuditRepository,
  type ToolAuthority,
  type ToolCall,
  type CleanupStatus,
  type AuditSettlement,
  type AdmissionLease,
  type AdmissionPolicy,
} from "../executor.js";
import { type ToolPermission } from "../registry.js";

interface Row {
  id: string;
  schema_version: 1;
  caller_id: string | null;
  project_id: string | null;
  tool_name: string | null;
  tool_version: string | null;
  input_hash: string | null;
  started_at_ms: string;
  finished_at_ms: string | null;
  outcome: ExecutionOutcome;
  code: string | null;
  cost_micros: string;
  job_id: string | null;
  cleanup_status: CleanupStatus;
  cleanup_code: "cleanup_unconfirmed" | null;
  stop_code: "cancelled" | "timed_out" | null;
  cost_basis: "actual" | "reserved" | "none";
}
function record(r: Row): ExecutionRecord {
  return {
    schemaVersion: r.schema_version,
    id: r.id,
    callerId: r.caller_id,
    projectId: r.project_id,
    toolName: r.tool_name,
    toolVersion: r.tool_version,
    inputHash: r.input_hash,
    startedAtMs: Number(r.started_at_ms),
    finishedAtMs: r.finished_at_ms === null ? null : Number(r.finished_at_ms),
    durationMs:
      r.finished_at_ms === null ? null : Number(r.finished_at_ms) - Number(r.started_at_ms),
    outcome: r.outcome,
    code: r.code,
    costMicros: Number(r.cost_micros),
    jobId: r.job_id,
    cleanupStatus: r.cleanup_status,
    cleanupCode: r.cleanup_code,
    stopCode: r.stop_code,
    costBasis: r.cost_basis,
  };
}
export class PostgresToolAuditRepository implements ToolAuditRepository {
  constructor(
    private readonly pool: Pool,
    private readonly projectCostLimitMicros: number,
  ) {
    if (!Number.isSafeInteger(projectCostLimitMicros) || projectCostLimitMicros < 0)
      throw new ToolError("invalid_budget");
  }
  async begin(r: ExecutionRecord, admission?: AdmissionLease): Promise<void> {
    if (admission) {
      checkedId(admission.ownerId);
      if (
        !Number.isSafeInteger(admission.deadlineAtMs) ||
        admission.deadlineAtMs <= r.startedAtMs ||
        !["remote", "in-process", "unknown"].includes(admission.mode)
      )
        throw new ToolError("invalid_call");
    }
    await this.pool.query(
      `INSERT INTO tool_executions (id,schema_version,caller_id,project_id,tool_name,tool_version,input_hash,started_at_ms,outcome,admission_owner_id,admission_deadline_at_ms,execution_mode) VALUES ($1,1,$2,$3,$4,$5,$6,$7,'running',$8,$9,$10)`,
      [
        r.id,
        r.callerId,
        r.projectId,
        r.toolName,
        r.toolVersion,
        r.inputHash,
        r.startedAtMs,
        admission?.ownerId ?? null,
        // Legacy callers without a lease may use the manifest's maximum ten minutes.
        admission?.deadlineAtMs ?? r.startedAtMs + 600000,
        admission?.mode ?? "unknown",
      ],
    );
  }
  async reserve(id: string, projectId: string, cost: number, ownerId?: string): Promise<void> {
    if (!Number.isSafeInteger(cost) || cost < 0) throw new ToolError("invalid_cost");
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [projectId]);
      // Lock admission before any budget mutation. Recovery/late reserve are mutually fenced.
      const admission = await c.query(
        `SELECT id FROM tool_executions WHERE id=$1 AND project_id=$2 AND outcome='running'
        AND stop_code IS NULL AND admission_deadline_at_ms > (extract(epoch FROM clock_timestamp())*1000)::bigint
        AND (admission_owner_id IS NULL OR admission_owner_id=$3::uuid) FOR UPDATE`,
        [id, projectId, ownerId ?? null],
      );
      if (admission.rowCount !== 1) throw new ToolError("timed_out");
      const r = await c.query<{ total: string }>(
        "SELECT COALESCE(sum(cost_micros),0)::text AS total FROM tool_cost_reservations WHERE project_id=$1",
        [projectId],
      );
      if (BigInt(r.rows[0]!.total) + BigInt(cost) > BigInt(this.projectCostLimitMicros))
        throw new ToolError("budget_exceeded");
      await c.query("INSERT INTO tool_cost_reservations VALUES ($1,$2,$3)", [id, projectId, cost]);
      await c.query(
        "UPDATE tool_executions SET cost_micros=$2,cost_basis='reserved' WHERE id=$1 AND outcome='running'",
        [id, cost],
      );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async finish(
    id: string,
    outcome: Exclude<ExecutionOutcome, "running">,
    code: string | null,
    cost: number,
    settlement: AuditSettlement = {},
  ): Promise<ExecutionRecord> {
    code = code === null ? null : safeErrorCode(code);
    const at = settlement.finishedAtMs ?? Date.now();
    if (!Number.isSafeInteger(cost) || cost < 0 || !Number.isSafeInteger(at) || at < 0)
      throw new ToolError("invalid_cost");
    const cleanup = settlement.cleanupStatus ?? "not_required";
    const basis =
      settlement.costBasis ?? (outcome === "succeeded" ? "actual" : cost ? "reserved" : "none");
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      // A remote implementation cannot run without a durable Job. Prove unused exposure
      // under the same audit lock used by attach/Job insertion; never release local work this way.
      await c.query("SELECT id FROM tool_executions WHERE id=$1 FOR UPDATE", [id]);
      const unused = await c.query(
        `SELECT e.id FROM tool_executions e WHERE e.id=$1 AND e.outcome='running' AND e.execution_mode='remote'
        AND (NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id=e.id OR j.id=e.job_id)
          OR EXISTS (SELECT 1 FROM jobs j JOIN tool_remote_calls r ON r.execution_id=e.id
            WHERE j.id=e.job_id AND j.status='Cancelled' AND j.attempt_count=0
            AND r.result IS NULL AND r.cleanup_status='not_required'
            AND NOT EXISTS (SELECT 1 FROM job_attempts a WHERE a.job_id=j.id)))`,
        [id],
      );
      if (unused.rowCount === 1 && outcome === "succeeded") throw new ToolError("remote_missing");
      if (unused.rowCount === 1) {
        cost = 0;
      }
      const r = await c.query<Row>(
        "UPDATE tool_executions SET outcome=$2,code=$3,cost_micros=$4,finished_at_ms=GREATEST(started_at_ms,$5),cleanup_status=CASE WHEN cleanup_status='failed' THEN cleanup_status WHEN job_id IS NOT NULL THEN COALESCE((SELECT r.cleanup_status FROM tool_remote_calls r WHERE r.execution_id=tool_executions.id),'unconfirmed') ELSE $6 END,cleanup_code=CASE WHEN cleanup_status='failed' OR (job_id IS NULL AND $6 IN ('failed','unconfirmed')) OR (job_id IS NOT NULL AND COALESCE((SELECT r.cleanup_status FROM tool_remote_calls r WHERE r.execution_id=tool_executions.id),'unconfirmed') IN ('failed','unconfirmed')) THEN 'cleanup_unconfirmed' ELSE NULL END,cost_basis=$7 WHERE id=$1 AND outcome='running' RETURNING *",
        [id, outcome, code, cost, at, cleanup, unused.rowCount === 1 ? "none" : basis],
      );
      if (r.rows[0])
        await c.query("UPDATE tool_cost_reservations SET cost_micros=$2 WHERE execution_id=$1", [
          id,
          cost,
        ]);
      const existing =
        r.rows[0] ??
        (await c.query<Row>("SELECT * FROM tool_executions WHERE id=$1", [id])).rows[0];
      if (!existing) throw new ToolError("audit_missing");
      await c.query("COMMIT");
      return record(existing);
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async noteCleanupFailure(id: string): Promise<void> {
    await this.pool.query(
      "UPDATE tool_executions SET cleanup_status='failed',cleanup_code='cleanup_unconfirmed' WHERE id=$1 AND outcome='running'",
      [id],
    );
  }
  async confirmCleanup(id: string, status: CleanupStatus): Promise<void> {
    if (status === "unconfirmed") return;
    await this.pool.query(
      `UPDATE tool_executions SET cleanup_status=$2,cleanup_code=CASE WHEN $2='failed' THEN 'cleanup_unconfirmed' ELSE NULL END
      WHERE id=$1 AND cleanup_status='unconfirmed'`,
      [id, status],
    );
  }
  async requestStop(id: string, code: "cancelled" | "timed_out"): Promise<void> {
    if (code !== "cancelled" && code !== "timed_out") throw new ToolError("invalid_call");
    await this.pool.query(
      "UPDATE tool_executions SET stop_code=COALESCE(stop_code,$2) WHERE id=$1 AND outcome='running'",
      [id, code],
    );
  }
  async pendingRemote(limit: number, executionId?: string): Promise<readonly ExecutionRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new ToolError("invalid_query");
    if (executionId) checkedId(executionId);
    // Filter terminal Jobs before LIMIT: active work cannot starve restart reconciliation.
    const r = await this.pool.query<Row>(
      `SELECT e.* FROM tool_executions e JOIN jobs j ON j.id=e.job_id
      WHERE (e.outcome='running' OR (e.cleanup_status='unconfirmed' AND EXISTS (SELECT 1 FROM tool_remote_calls r WHERE r.execution_id=e.id AND r.cleanup_status<>'unconfirmed'))) AND j.status IN ('Completed','Failed','Cancelled') AND ($2::uuid IS NULL OR e.id=$2)
      ORDER BY e.started_at_ms,e.id LIMIT $1`,
      [limit, executionId ?? null],
    );
    return r.rows.map(record);
  }
  async attachJob(id: string, jobId: string, ownerId?: string): Promise<void> {
    if (id !== jobId) throw new ToolError("remote_binding_mismatch");
    const r = await this.pool.query(
      `UPDATE tool_executions SET job_id=$2 WHERE id=$1 AND outcome='running' AND stop_code IS NULL
      AND admission_deadline_at_ms > (extract(epoch FROM clock_timestamp())*1000)::bigint
      AND (admission_owner_id IS NULL OR admission_owner_id=$3::uuid) AND (job_id IS NULL OR job_id=$2)`,
      [id, jobId, ownerId ?? null],
    );
    if (r.rowCount !== 1) throw new ToolError("timed_out");
  }
  async recoverAdmissions(
    limit: number,
    executionId?: string,
    policies: readonly AdmissionPolicy[] = [],
  ): Promise<readonly ExecutionRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new ToolError("invalid_query");
    if (executionId) checkedId(executionId);
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      // Job insertion takes the same audit lock in the outbox trigger. Thus there is no
      // Upgrade expired pre-lease audits from trusted registered immutable name/version.
      // Active old coordinators retain their original lease until its declared expiry.
      await c.query(
        `UPDATE tool_executions e SET admission_owner_id=e.id,
        admission_deadline_at_ms=e.started_at_ms+p.timeout_ms,execution_mode=p.mode
        FROM jsonb_to_recordset($1::jsonb) AS p(name text,version text,timeout_ms bigint,mode text)
        WHERE e.admission_owner_id IS NULL AND e.outcome='running' AND e.tool_name=p.name
        AND e.tool_version=p.version AND e.started_at_ms+p.timeout_ms <= (extract(epoch FROM clock_timestamp())*1000)::bigint
        AND ($2::uuid IS NULL OR e.id=$2)`,
        [
          JSON.stringify(
            policies.map((p) => ({
              name: p.name,
              version: p.version,
              timeout_ms: p.timeoutMs,
              mode: p.mode,
            })),
          ),
          executionId ?? null,
        ],
      );
      // check/settle race, including an insert already in-flight when expiry wins.
      // Repair an interrupted historical attachment only from an existing, outbox-bound
      // canonical Job and matching private identity; the dispatcher still validates its receipt.
      await c.query(
        `UPDATE tool_executions e SET job_id=j.id FROM jobs j,tool_remote_calls r,tool_job_publications p
        WHERE e.job_id IS NULL AND e.outcome='running' AND j.id=e.id AND r.execution_id=e.id AND p.job_id=j.id
        AND j.job_type='tool.execute.v1' AND j.subject_kind='project' AND j.subject_id=e.project_id
        AND j.payload->>'executionId'=e.id::text AND j.payload->>'schemaVersion'='1'
        AND r.call->>'executionId'=e.id::text AND r.call->>'projectId'=e.project_id::text
        AND r.call->>'callerId'=e.caller_id::text AND r.call->>'inputHash'=e.input_hash
        AND r.call->>'name'=e.tool_name AND r.call->>'version'=e.tool_version
        AND ($1::uuid IS NULL OR e.id=$1)`,
        [executionId ?? null],
      );
      const candidates = await c.query<
        Row & { admission_deadline_at_ms: string; execution_mode: string }
      >(
        `SELECT e.* FROM tool_executions e WHERE e.outcome='running'
        AND e.admission_deadline_at_ms <= (extract(epoch FROM clock_timestamp())*1000)::bigint
        AND ($2::uuid IS NULL OR e.id=$2) AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id=e.id OR j.id=e.job_id)
        ORDER BY e.admission_deadline_at_ms,e.id LIMIT $1 FOR UPDATE OF e SKIP LOCKED`,
        [limit, executionId ?? null],
      );
      const recovered: ExecutionRecord[] = [];
      for (const e of candidates.rows) {
        // Recheck after acquiring the row lock: a concurrent inserter may have committed
        // while this statement waited. Never infer success or release Job-backed exposure.
        const job = await c.query("SELECT id FROM jobs WHERE id=$1 OR id=$2", [e.id, e.job_id]);
        if (job.rowCount) continue;
        const remote = e.execution_mode === "remote" || e.cost_basis === "none";
        const outcome = e.stop_code === "cancelled" ? "cancelled" : "timed_out";
        const r = await c.query<Row>(
          `UPDATE tool_executions SET outcome=$2,code=$2,stop_code=COALESCE(stop_code,$2),
          finished_at_ms=GREATEST(started_at_ms,admission_deadline_at_ms),cost_micros=$3,cost_basis=$4,
          cleanup_status=$5,cleanup_code=$6 WHERE id=$1 AND outcome='running' RETURNING *`,
          [
            e.id,
            outcome,
            remote ? 0 : e.cost_micros,
            remote ? "none" : e.cost_basis,
            remote ? "not_required" : "unconfirmed",
            remote ? null : "cleanup_unconfirmed",
          ],
        );
        if (r.rows[0]) {
          await c.query("UPDATE tool_cost_reservations SET cost_micros=$2 WHERE execution_id=$1", [
            e.id,
            remote ? 0 : e.cost_micros,
          ]);
          recovered.push(record(r.rows[0]));
        }
      }
      await c.query("COMMIT");
      return recovered;
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  }
  async get(id: string): Promise<ExecutionRecord | null> {
    checkedId(id);
    const r = await this.pool.query<Row>("SELECT * FROM tool_executions WHERE id=$1", [id]);
    return r.rows[0] ? record(r.rows[0]) : null;
  }
  async list(projectId: string, limit: number): Promise<readonly ExecutionRecord[]> {
    const r = await this.pool.query<Row>(
      "SELECT * FROM tool_executions WHERE project_id=$1 ORDER BY started_at_ms DESC,id LIMIT $2",
      [projectId, limit],
    );
    return r.rows.map(record);
  }
}
/** Authenticated identity is supplied by the server. No role or grants are trusted from model input. */
export class PostgresToolAuthority implements ToolAuthority {
  constructor(
    private readonly pool: Pool,
    private readonly loadTimeline: (projectId: string, timelineId: string) => Promise<Timeline>,
  ) {}
  async authorize(
    call: Pick<ToolCall, "callerId" | "projectId" | "resource">,
    permissions: readonly ToolPermission[],
  ): Promise<void> {
    if (
      !Array.isArray(permissions) ||
      permissions.some(
        (p) =>
          ![
            "project.read",
            "timeline.propose",
            "asset.read",
            "analysis.read",
            "render.create",
          ].includes(p),
      ) ||
      !["project", "asset", "timeline"].includes(call.resource.kind)
    )
      throw new ToolError("denied");
    checkedId(call.callerId);
    checkedId(call.projectId);
    checkedId(call.resource.id);
    const r = await this.pool.query<{ role: string }>(
      `SELECT m.role FROM project_memberships m JOIN projects p ON p.id=m.project_id JOIN users u ON u.id=m.user_id WHERE m.project_id=$1 AND m.user_id=$2 AND p.deleted_at IS NULL`,
      [call.projectId, call.callerId],
    );
    const role = r.rows[0]?.role;
    if (!["owner", "editor", "viewer"].includes(role ?? "")) throw new ToolError("denied");
    if (
      permissions.some((p) => !["project.read", "asset.read", "analysis.read"].includes(p)) &&
      role !== "owner" &&
      role !== "editor"
    )
      throw new ToolError("denied");
    if (permissions.includes("timeline.propose") && call.resource.kind !== "timeline")
      throw new ToolError("denied");
    if (call.resource.kind === "project" && call.resource.id !== call.projectId)
      throw new ToolError("denied");
    if (call.resource.kind === "asset") {
      const a = await this.pool.query(
        "SELECT id FROM media_assets WHERE id=$1 AND project_id=$2 UNION ALL SELECT id FROM derived_assets WHERE id=$1 AND project_id=$2 AND kind='edited-video'",
        [call.resource.id, call.projectId],
      );
      if (a.rowCount !== 1) throw new ToolError("denied");
    } else if (call.resource.kind === "timeline") {
      const t = await this.timeline(call.projectId, call.resource.id);
      if (t.projectId !== call.projectId || t.id !== call.resource.id)
        throw new ToolError("denied");
    }
  }
  timeline(projectId: string, timelineId: string): Promise<Timeline> {
    return this.loadTimeline(projectId, timelineId);
  }
}

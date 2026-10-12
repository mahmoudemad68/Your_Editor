import { type EnqueueJobCommand, projectId, jobId } from "@editagent/domain";
import { type CleanupStatus } from "../executor.js";
import { type Pool } from "pg";
import { type RemoteCall, type RemoteCallStore } from "../remote.js";
import { type ToolResult } from "../registry.js";
import { ToolError, canonicalJson, contentHash } from "../validation.js";
export class PostgresRemoteCallStore implements RemoteCallStore {
  constructor(private readonly pool: Pool) {}
  async put(call: RemoteCall): Promise<void> {
    const hash = contentHash(call);
    await this.pool.query(
      "INSERT INTO tool_remote_calls(execution_id,binding_hash,call) VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING",
      [call.executionId, hash, canonicalJson(call)],
    );
    const existing = await this.get(call.executionId);
    if (!existing || contentHash(existing) !== hash) throw new ToolError("remote_binding_mismatch");
  }
  async get(id: string): Promise<RemoteCall | null> {
    const r = await this.pool.query<{ call: RemoteCall; binding_hash: string }>(
      "SELECT call,binding_hash FROM tool_remote_calls WHERE execution_id=$1",
      [id],
    );
    const row = r.rows[0];
    if (!row) return null;
    if (contentHash(row.call) !== row.binding_hash) throw new ToolError("remote_binding_mismatch");
    return row.call;
  }
  async cleanup(id: string): Promise<CleanupStatus> {
    const r = await this.pool.query<{ cleanup_status: CleanupStatus }>(
      "SELECT CASE WHEN e.job_id IS NULL THEN 'not_required' ELSE COALESCE(r.cleanup_status,'unconfirmed') END AS cleanup_status FROM tool_executions e LEFT JOIN tool_remote_calls r ON r.execution_id=e.id WHERE e.id=$1",
      [id],
    );
    return r.rows[0]?.cleanup_status ?? "unconfirmed";
  }
  async noteCleanup(id: string, status: CleanupStatus): Promise<void> {
    const r = await this.pool.query(
      "UPDATE tool_remote_calls SET cleanup_status=$2 WHERE execution_id=$1",
      [id, status],
    );
    if (r.rowCount !== 1) throw new ToolError("cleanup_unconfirmed");
  }
  async fence(id: string): Promise<void> {
    // Never depends on Redis responding. Running work observes the durable audit stop intent itself.
    await this.pool.query(
      `UPDATE jobs SET status='Cancelled',updated_at=GREATEST(updated_at,
      (extract(epoch FROM clock_timestamp())*1000)::bigint) WHERE id=$1 AND job_type='tool.execute.v1' AND status IN ('Queued','Retrying')`,
      [id],
    );
  }
  async claimPublications(
    limit: number,
    executionId?: string,
  ): Promise<readonly EnqueueJobCommand[]> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      // Expiry/cancellation wins even for a previously acknowledged publication still waiting in Redis.
      await c.query(`UPDATE tool_executions e SET stop_code=COALESCE(e.stop_code,'timed_out')
        FROM tool_job_publications p JOIN jobs j ON j.id=p.job_id WHERE e.id=p.job_id AND e.outcome='running'
        AND j.status IN ('Queued','Retrying','Running') AND p.deadline_at_ms <= (extract(epoch FROM clock_timestamp())*1000)::bigint`);
      await c.query(`UPDATE jobs j SET status='Cancelled',updated_at=GREATEST(j.updated_at,
        (extract(epoch FROM clock_timestamp())*1000)::bigint) FROM tool_executions e
        WHERE j.id=e.job_id AND j.job_type='tool.execute.v1' AND j.status IN ('Queued','Retrying') AND (e.stop_code IS NOT NULL OR e.outcome<>'running')`);
      const rows = await c.query<{
        id: string;
        queue_name: string;
        job_type: string;
        idempotency_key: string;
        payload: Record<string, unknown>;
        subject_id: string;
        timeout_ms: number;
        max_attempts: number;
      }>(
        `
        WITH candidates AS (
          SELECT p.job_id FROM tool_job_publications p JOIN jobs j ON j.id=p.job_id
          JOIN tool_executions e ON e.id=p.job_id WHERE NOT p.published AND j.status='Queued'
          AND e.outcome='running' AND e.stop_code IS NULL AND p.deadline_at_ms > (extract(epoch FROM clock_timestamp())*1000)::bigint
          AND p.lease_until_ms <= (extract(epoch FROM clock_timestamp())*1000)::bigint
          AND ($2::uuid IS NULL OR p.job_id=$2) ORDER BY j.created_at,p.job_id LIMIT $1 FOR UPDATE OF p SKIP LOCKED
        ), claimed AS (
          UPDATE tool_job_publications p SET lease_until_ms=(extract(epoch FROM clock_timestamp())*1000)::bigint+1000
          FROM candidates WHERE p.job_id=candidates.job_id RETURNING p.job_id
        ) SELECT j.* FROM jobs j JOIN claimed ON j.id=claimed.job_id`,
        [limit, executionId ?? null],
      );
      await c.query("COMMIT");
      return rows.rows.map((j) => ({
        id: jobId(j.id),
        queueName: j.queue_name,
        jobType: j.job_type,
        idempotencyKey: j.idempotency_key,
        payload: j.payload,
        subject: { kind: "project", projectId: projectId(j.subject_id) },
        timeoutMs: j.timeout_ms,
        maxAttempts: j.max_attempts,
        backoffBaseMs: 50,
      }));
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  }
  async acknowledgePublication(id: string): Promise<void> {
    await this.pool.query("UPDATE tool_job_publications SET published=true WHERE job_id=$1", [id]);
  }
  async result(id: string): Promise<ToolResult | null> {
    const r = await this.pool.query<{ result: ToolResult | null }>(
      "SELECT result FROM tool_remote_calls WHERE execution_id=$1",
      [id],
    );
    return r.rows[0]?.result ?? null;
  }
  async complete(id: string, result: ToolResult): Promise<void> {
    await this.pool.query(
      `UPDATE tool_remote_calls r SET result=$2::jsonb FROM tool_executions e WHERE r.execution_id=$1 AND e.id=r.execution_id AND e.outcome='running' AND e.stop_code IS NULL AND r.cleanup_status='succeeded' AND r.result IS NULL AND EXISTS (SELECT 1 FROM jobs j WHERE j.id=e.job_id AND j.status='Running')`,
      [id, canonicalJson(result)],
    );
    const stored = await this.result(id);
    if (!stored || contentHash(stored) !== contentHash(result))
      throw new ToolError("remote_result_conflict");
  }
}

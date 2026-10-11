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
  async result(id: string): Promise<ToolResult | null> {
    const r = await this.pool.query<{ result: ToolResult | null }>(
      "SELECT result FROM tool_remote_calls WHERE execution_id=$1",
      [id],
    );
    return r.rows[0]?.result ?? null;
  }
  async complete(id: string, result: ToolResult): Promise<void> {
    await this.pool.query(
      `UPDATE tool_remote_calls r SET result=$2::jsonb FROM tool_executions e WHERE r.execution_id=$1 AND e.id=r.execution_id AND e.outcome='running' AND r.result IS NULL AND EXISTS (SELECT 1 FROM jobs j WHERE j.id=e.job_id AND j.status='Running')`,
      [id, canonicalJson(result)],
    );
    const stored = await this.result(id);
    if (!stored || contentHash(stored) !== contentHash(result))
      throw new ToolError("remote_result_conflict");
  }
}

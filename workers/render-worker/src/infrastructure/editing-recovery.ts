import type { Pool } from "pg";
import { DerivedAsset, type DerivedAssetSnapshot } from "@editagent/domain";
import { contentHash } from "@editagent/tool-sdk";
import type { RenderObjects } from "./storage.js";
/** Only terminal, cleanup-acknowledged unpublished objects are reclaimable; never sources/valid results. */
export async function reclaimEditingOutputs(
  pool: Pool,
  objects: RenderObjects,
  signal: AbortSignal,
): Promise<number> {
  const rows = await pool.query<{
    execution_id: string;
  }>(`SELECT i.execution_id FROM editing_output_intents i JOIN tool_executions e ON e.id=i.execution_id JOIN jobs j ON j.id=e.job_id
    WHERE NOT i.published AND NOT i.discarded AND e.outcome IN ('failed','cancelled','timed_out') AND e.cleanup_status IN ('succeeded','not_required')
    AND j.status IN ('Failed','Cancelled') ORDER BY e.finished_at_ms LIMIT 4`);
  let count = 0;
  for (const row of rows.rows) {
    signal.throwIfAborted();
    const c = await pool.connect();
    let locked = false;
    try {
      locked =
        (
          await c.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
            [row.execution_id],
          )
        ).rows[0]?.locked === true;
      if (!locked) continue;
      const r = await c.query<{
        descriptor: { asset: DerivedAssetSnapshot };
        descriptor_sha256: string;
        project_id: string;
      }>(
        `SELECT i.descriptor,i.descriptor_sha256,e.project_id::text FROM editing_output_intents i JOIN tool_executions e ON e.id=i.execution_id JOIN jobs j ON j.id=e.job_id
        WHERE i.execution_id=$1 AND NOT i.published AND NOT i.discarded AND e.outcome IN ('failed','cancelled','timed_out') AND e.cleanup_status IN ('succeeded','not_required')
        AND j.status IN ('Failed','Cancelled') AND NOT EXISTS(SELECT 1 FROM derived_assets d WHERE d.storage_key=i.descriptor->'asset'->'artifact'->>'storageKey')`,
        [row.execution_id],
      );
      const v = r.rows[0];
      if (!v) continue;
      const a = DerivedAsset.restore(v.descriptor.asset).artifact;
      if (!a || a.projectId !== v.project_id || contentHash(v.descriptor) !== v.descriptor_sha256)
        throw new Error("Invalid editing recovery identity.");
      await objects.remove(a.storageKey, a.parameterSignature);
      await c.query(
        "UPDATE editing_output_intents SET discarded=true WHERE execution_id=$1 AND NOT published",
        [row.execution_id],
      );
      count++;
    } finally {
      try {
        if (locked)
          await c.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [row.execution_id]);
      } finally {
        c.release();
      }
    }
  }
  return count;
}

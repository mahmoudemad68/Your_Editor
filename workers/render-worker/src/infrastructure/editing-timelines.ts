import type { Pool } from "pg";
import { Timeline, uuidV7 } from "@editagent/domain";
import { contentHash, ToolError } from "@editagent/tool-sdk";
/** Internal validated/CAS persistence port. No public endpoint or autonomous mutation. */
export class EditingTimelines {
  constructor(private readonly pool: Pick<Pool, "query">) {}
  async load(projectId: string, id: string): Promise<Timeline> {
    uuidV7(projectId);
    uuidV7(id);
    const r = await this.pool.query<{ snapshot: unknown; state_sha256: string }>(
      "SELECT t.snapshot,t.state_sha256 FROM editing_timelines t JOIN projects p ON p.id=t.project_id WHERE t.id=$1 AND t.project_id=$2 AND p.deleted_at IS NULL",
      [id, projectId],
    );
    if (!r.rows[0] || contentHash(r.rows[0].snapshot) !== r.rows[0].state_sha256)
      throw new ToolError("invalid_subject");
    const timeline = Timeline.restore(r.rows[0].snapshot as Parameters<typeof Timeline.restore>[0]);
    if (timeline.projectId !== projectId || timeline.id !== id)
      throw new ToolError("invalid_subject");
    return timeline;
  }
  async save(timeline: Timeline, expectedHash: string | null): Promise<string> {
    const snapshot = Timeline.restore(timeline.toSnapshot()).toSnapshot(),
      hash = contentHash(snapshot);
    const r =
      expectedHash === null
        ? await this.pool.query(
            "INSERT INTO editing_timelines(id,project_id,snapshot,state_sha256) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT DO NOTHING",
            [timeline.id, timeline.projectId, JSON.stringify(snapshot), hash],
          )
        : await this.pool.query(
            "UPDATE editing_timelines SET snapshot=$3::jsonb,state_sha256=$4 WHERE id=$1 AND project_id=$2 AND state_sha256=$5",
            [timeline.id, timeline.projectId, JSON.stringify(snapshot), hash, expectedHash],
          );
    if (r.rowCount !== 1) throw new ToolError("invalid_commands");
    return hash;
  }
}

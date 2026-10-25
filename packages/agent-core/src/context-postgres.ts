import { type Pool } from "pg";
import { Timeline } from "@editagent/domain";
import {
  contentHash,
  PostgresToolAuthority,
  ToolError,
  type ToolRegistry,
} from "@editagent/tool-sdk";
import {
  ContextError,
  validateContextRequest,
  type ContextRequest,
  type AgentContextSource,
  type ContextSnapshot,
} from "./context.js";

export interface ContextToolPolicy {
  readonly pins: readonly { name: string; version: string }[];
  readonly creativity: readonly ContextRequest["creator"]["creativity"][];
}
/** No API/model-supplied grants. The trusted composition pins the registered
 * tool intersection; current Tool SDK authority rechecks every exposed tool. */
export class PostgresAgentContextSource implements AgentContextSource {
  private readonly policy: ContextToolPolicy;
  constructor(
    private readonly pool: Pool,
    private readonly registry: ToolRegistry,
    policy: ContextToolPolicy,
  ) {
    if (
      policy.pins.length > 32 ||
      policy.creativity.length < 1 ||
      policy.creativity.some((c) => !["conservative", "balanced", "creative"].includes(c))
    )
      throw new ContextError("invalid_policy");
    for (const p of policy.pins)
      try {
        registry.lookup(p.name, p.version);
      } catch {
        throw new ContextError("invalid_policy");
      }
    this.policy = JSON.parse(JSON.stringify(policy)) as ContextToolPolicy;
  }
  async withSnapshot<T>(r: ContextRequest, read: (snapshot: ContextSnapshot) => T): Promise<T> {
    validateContextRequest(r);
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      // FOR SHARE serializes revocation/deletion while protected context is built.
      const access = await db.query(
        "SELECT p.id FROM projects p JOIN project_memberships m ON m.project_id=p.id WHERE p.id=$1 AND m.user_id=$2 AND p.deleted_at IS NULL FOR SHARE OF p,m",
        [r.projectId, r.actorId],
      );
      if (access.rowCount !== 1) throw new ContextError("not_found");
      const run = (
        await db.query<{
          source_timeline_id: string | null;
          source_sha256: string | null;
          source_snapshot: unknown;
        }>(
          "SELECT source_timeline_id,source_sha256,source_snapshot FROM agent_runs WHERE id=$1 AND project_id=$2 AND actor_id=$3 FOR SHARE",
          [r.runId, r.projectId, r.actorId],
        )
      ).rows[0];
      if (!run) throw new ContextError("not_found");
      if (
        !run.source_timeline_id ||
        run.source_sha256 !== r.expectedSourceSha256 ||
        contentHash(run.source_snapshot) !== run.source_sha256
      )
        throw new ContextError("stale_source");
      const timeline = Timeline.restore(run.source_snapshot).toSnapshot();
      if (
        timeline.projectId !== r.projectId ||
        timeline.id !== run.source_timeline_id ||
        timeline.sources.length > 16
      )
        throw new ContextError("stale_source");
      const assets = await db.query<{
        id: string;
        content_sha256: string;
        document: unknown | null;
      }>(
        "SELECT m.id,m.content_sha256,a.document FROM media_assets m LEFT JOIN media_analyses a ON a.media_asset_id=m.id AND a.project_id=m.project_id AND a.source_sha256=m.content_sha256 WHERE m.project_id=$1 AND m.id=ANY($2::uuid[]) ORDER BY m.id FOR SHARE OF m",
        [r.projectId, timeline.sources.map((x) => x.id)],
      );
      if (assets.rowCount !== timeline.sources.length) throw new ContextError("not_found");
      if (!this.policy.creativity.includes(r.creator.creativity))
        throw new ContextError("invalid_policy");
      const authority = new PostgresToolAuthority(db as unknown as Pool, async (project, id) => {
        if (project !== r.projectId || id !== timeline.id) throw new ToolError("denied");
        return Timeline.restore(timeline);
      });
      const tools = [];
      for (const pin of this.policy.pins) {
        const m = this.registry.lookup(pin.name, pin.version).manifest;
        // This substrate supports existing timeline-scoped tools only. Other resource
        // consumers need their own bound, reviewed context policy before exposure.
        try {
          await authority.authorize(
            {
              callerId: r.actorId,
              projectId: r.projectId,
              resource: { kind: "timeline", id: timeline.id },
            },
            m.permissions,
          );
          tools.push(m);
        } catch (e) {
          if (!(e instanceof ToolError) || e.code !== "denied") throw e;
        }
      }
      const output = read({
        runId: r.runId,
        projectId: r.projectId,
        timeline,
        sourceSha256: run.source_sha256,
        analyses: assets.rows.map((a) => ({
          assetId: a.id,
          sourceSha256: a.content_sha256,
          document: a.document,
        })),
        tools,
      });
      await db.query("COMMIT");
      return output;
    } catch (e) {
      await db.query("ROLLBACK");
      throw e instanceof ContextError ? e : new ContextError("unavailable");
    } finally {
      db.release();
    }
  }
}

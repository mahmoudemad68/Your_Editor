import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  Timeline,
  createUuidV7,
  uuidV7,
  applyCommand,
  applyInverse,
  type UserId,
  type ProjectId,
} from "@editagent/domain";
import {
  ToolExecutor,
  ToolRegistry,
  ToolError,
  PostgresToolAuthority,
  PostgresToolAuditRepository,
  PostgresCaptionEvidence,
  registerCaptionTools,
  contentHash,
} from "@editagent/tool-sdk";
import type { CaptionEditPort, CaptionEditRequest } from "../application/timeline-captions.js";
import { TimelineConflict } from "../application/timeline-editor.js";
import { ProjectNotFoundError } from "../application/project-access.js";
import { PostgresTimelineStore } from "./postgres-timeline-store.js";

type Receipt = {
  id: string;
  input_sha256: string;
  status: string;
  command: unknown;
  inverse: unknown;
  result_sha256: string | null;
  operation: string;
  created_at: Date;
};
export class PostgresCaptionEdits implements CaptionEditPort {
  private readonly store: PostgresTimelineStore;
  private readonly authority: PostgresToolAuthority;
  private executor: ToolExecutor | undefined;
  constructor(private readonly pool: Pool) {
    this.store = new PostgresTimelineStore(pool);
    this.authority = new PostgresToolAuthority(
      pool,
      async (p, t) => (await this.store.load(p, t)).timeline,
    );
  }
  private tools(): ToolExecutor {
    // Optional caption manifests compile on first use, outside API/auth bootstrap.
    return (this.executor ??= new ToolExecutor(
      registerCaptionTools(
        new ToolRegistry(),
        this.authority,
        new PostgresCaptionEvidence(this.pool),
      ),
      this.authority,
      new PostgresToolAuditRepository(this.pool, 1000000),
    ));
  }
  private async authorize(actor: string, project: string, timeline: string, write = true) {
    try {
      await this.authority.authorize(
        { callerId: actor, projectId: project, resource: { kind: "timeline", id: timeline } },
        write ? ["project.read", "timeline.propose"] : ["project.read"],
      );
    } catch {
      throw new ProjectNotFoundError();
    }
  }
  private async response(actor: string, project: string, timeline: string) {
    await this.authorize(actor, project, timeline, false);
    const stored = await this.store.load(project, timeline);
    await this.authorize(actor, project, timeline, false);
    return { timeline: stored.timeline.toSnapshot(), stateSha256: stored.stateSha256 };
  }
  async source(actor: UserId, project: ProjectId, timeline: string, asset: string) {
    uuidV7(asset);
    await this.authorize(actor, project, timeline, false);
    const loaded = await this.store.load(project, timeline);
    if (!loaded.timeline.sources.some((s) => s.id === asset)) throw new ProjectNotFoundError();
    const row = (
      await this.pool.query<{ source_sha256: string; document: unknown }>(
        "SELECT source_sha256,document FROM media_analyses WHERE project_id=$1 AND media_asset_id=$2",
        [project, asset],
      )
    ).rows[0];
    if (!row) throw new TimelineConflict();
    const analysisSha256 = contentHash(row.document);
    try {
      await new PostgresCaptionEvidence(this.pool).read(
        project,
        asset,
        row.source_sha256,
        analysisSha256,
        new AbortController().signal,
      );
    } catch {
      throw new TimelineConflict();
    }
    await this.authorize(actor, project, timeline, false);
    return { assetId: asset, sourceSha256: row.source_sha256, analysisSha256 };
  }
  private async locked(
    client: PoolClient,
    actor: string,
    project: string,
    timeline: string,
    expected: string,
  ) {
    await client.query("SET LOCAL lock_timeout='3s'");
    const row = (
      await client.query<{ snapshot: unknown; state_sha256: string }>(
        `SELECT t.snapshot,t.state_sha256 FROM editing_timelines t JOIN projects p ON p.id=t.project_id
       JOIN project_memberships m ON m.project_id=p.id WHERE t.id=$1 AND p.id=$2 AND p.deleted_at IS NULL
       AND m.user_id=$3 AND m.role IN ('owner','editor') FOR UPDATE OF t FOR SHARE OF p,m`,
        [timeline, project, actor],
      )
    ).rows[0];
    if (!row || row.state_sha256 !== expected || contentHash(row.snapshot) !== expected)
      throw new TimelineConflict();
    return Timeline.restore(row.snapshot);
  }
  async execute(actor: UserId, project: ProjectId, timeline: string, request: CaptionEditRequest) {
    uuidV7(request.requestId);
    uuidV7(timeline);
    if (
      !/^[a-f0-9]{64}$/.test(request.stateSha256) ||
      !["add-caption", "update-caption-style"].includes(request.operation)
    )
      throw new TimelineConflict();
    await this.authorize(actor, project, timeline);
    const inputHash = contentHash({ timeline, ...request });
    const execution = createUuidV7(
      Number(BigInt("0x" + request.requestId.replaceAll("-", "").slice(0, 12))),
      createHash("sha256")
        .update(`${project}:${actor}:${request.requestId}`)
        .digest()
        .subarray(0, 10),
    );
    const prior = (
      await this.pool.query<Receipt>(
        "SELECT * FROM editing_caption_commands WHERE project_id=$1 AND actor_id=$2 AND request_id=$3",
        [project, actor, request.requestId],
      )
    ).rows[0];
    if (prior) {
      if (prior.input_sha256 !== inputHash || prior.status !== "committed")
        throw new TimelineConflict();
      return this.response(actor, project, timeline);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.locked(client, actor, project, timeline, request.stateSha256);
      const admission = await client.query(
        `INSERT INTO editing_caption_commands(id,project_id,timeline_id,actor_id,request_id,input_sha256,basis_sha256,operation,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'admitted') ON CONFLICT DO NOTHING`,
        [
          execution,
          project,
          timeline,
          actor,
          request.requestId,
          inputHash,
          request.stateSha256,
          request.operation,
        ],
      );
      if (admission.rowCount !== 1) throw new TimelineConflict();
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    // The persisted admission precedes ToolExecutor. A crash/unknown result never
    // replays this execution. Only a committed matching receipt can be replayed.
    let proposal;
    try {
      proposal = await this.tools().executeWithIdentity(execution, {
        name: `editing.${request.operation}`,
        version: "1.0.0",
        callerId: actor,
        projectId: project,
        resource: { kind: "timeline", id: timeline },
        input: request.input,
      });
    } catch (error) {
      if (error instanceof ToolError) throw new TimelineConflict();
      throw error;
    }
    if (
      (proposal.output as { basisSha256: string }).basisSha256 !== request.stateSha256 ||
      proposal.commands.length !== 1
    )
      throw new TimelineConflict();
    const command = proposal.commands[0]!;
    if (
      command.id !== execution ||
      command.timelineId !== timeline ||
      command.type !==
        (request.operation === "add-caption" ? "AddTimedCaption" : "UpdateCaptionStyle")
    )
      throw new TimelineConflict();
    const commit = await this.pool.connect();
    try {
      await commit.query("BEGIN");
      const current = await this.locked(commit, actor, project, timeline, request.stateSha256);
      const receipt = (
        await commit.query<Receipt>(
          "SELECT * FROM editing_caption_commands WHERE id=$1 AND status='admitted' FOR UPDATE",
          [execution],
        )
      ).rows[0];
      if (!receipt || receipt.input_sha256 !== inputHash) throw new TimelineConflict();
      if (command.type === "AddTimedCaption") {
        const c = command.payload.caption;
        if (c.createdBy !== actor) throw new TimelineConflict();
        await commit.query(
          "SELECT m.id FROM media_assets m JOIN media_analyses a ON a.media_asset_id=m.id WHERE m.id=$1 AND m.project_id=$2 FOR SHARE OF m,a",
          [c.assetId, project],
        );
        await new PostgresCaptionEvidence(commit).read(
          project,
          c.assetId,
          c.sourceSha256,
          c.evidence.documentSha256,
          new AbortController().signal,
        );
      }
      const applied = applyCommand(current, command),
        snapshot = applied.timeline.toSnapshot(),
        hash = contentHash(snapshot);
      await commit.query(
        "UPDATE editing_timelines SET snapshot=$3::jsonb,state_sha256=$4 WHERE id=$1 AND project_id=$2",
        [timeline, project, JSON.stringify(snapshot), hash],
      );
      await commit.query(
        "UPDATE editing_caption_commands SET status='committed',command=$2::jsonb,inverse=$3::jsonb,result_sha256=$4 WHERE id=$1",
        [execution, JSON.stringify(command), JSON.stringify(applied.inverse), hash],
      );
      await commit.query("COMMIT");
    } catch (error) {
      await commit.query("ROLLBACK");
      throw error;
    } finally {
      commit.release();
    }
    return this.response(actor, project, timeline);
  }
  async undo(
    actor: UserId,
    project: ProjectId,
    timeline: string,
    command: string,
    expected: string,
  ) {
    uuidV7(command);
    await this.authorize(actor, project, timeline);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await this.locked(client, actor, project, timeline, expected);
      const receipt = (
        await client.query<Receipt>(
          "SELECT * FROM editing_caption_commands WHERE id=$1 AND project_id=$2 AND timeline_id=$3 AND actor_id=$4 FOR UPDATE",
          [command, project, timeline, actor],
        )
      ).rows[0];
      if (!receipt || receipt.status !== "committed" || receipt.result_sha256 !== expected)
        throw new TimelineConflict();
      const restored = applyInverse(current, receipt.inverse),
        snapshot = restored.toSnapshot(),
        hash = contentHash(snapshot);
      await client.query(
        "UPDATE editing_timelines SET snapshot=$2::jsonb,state_sha256=$3 WHERE id=$1",
        [timeline, JSON.stringify(snapshot), hash],
      );
      await client.query("UPDATE editing_caption_commands SET status='undone' WHERE id=$1", [
        command,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.response(actor, project, timeline);
  }
  async history(actor: UserId, project: ProjectId, timeline: string) {
    await this.authorize(actor, project, timeline, false);
    const rows = (
      await this.pool.query<Receipt>(
        "SELECT id,operation,status,created_at FROM editing_caption_commands WHERE project_id=$1 AND timeline_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100",
        [project, timeline],
      )
    ).rows;
    await this.authorize(actor, project, timeline, false);
    return rows.map((r) => ({
      id: r.id,
      operation: r.operation,
      status: r.status,
      createdAt: r.created_at.toISOString(),
    }));
  }
}

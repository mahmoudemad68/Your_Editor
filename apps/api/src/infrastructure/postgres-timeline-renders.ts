import type { Pool } from "pg";
import { createUuidV7, jobId, type Timeline, type UserId } from "@editagent/domain";
import {
  cancelJob,
  enqueueJob,
  IdempotencyConflictError,
  type RunJobDeps,
} from "@editagent/job-queue";
import { contentHash } from "@editagent/tool-sdk";
import { randomBytes } from "node:crypto";
import {
  RenderUnavailable,
  type TimelineRenderJobs,
  type TimelineRenderSnapshot,
} from "../application/timeline-exports.js";
import { TimelineConflict } from "../application/timeline-editor.js";
import { ProjectNotFoundError } from "../application/project-access.js";

/** Fixed producer for existing render.remotion/SelectingRenderStrategy; no paths or filters from HTTP. */
export class PostgresTimelineRenders implements TimelineRenderJobs {
  constructor(
    private readonly pool: Pool,
    private readonly deps: RunJobDeps,
    private readonly renderVersion?: string,
  ) {
    if (
      renderVersion !== undefined &&
      (renderVersion.length !== 64 || !/^[a-f0-9]{64}$/.test(renderVersion))
    )
      throw new Error("Invalid render version configuration.");
  }

  async enqueue(
    actor: UserId,
    timeline: Timeline,
    requestId: string,
  ): Promise<TimelineRenderSnapshot> {
    if (!this.renderVersion) throw new RenderUnavailable();
    if (requestId.length !== 36 || !/^req_[a-f0-9]{32}$/.test(requestId))
      throw new TimelineConflict();
    const snapshot = timeline.toSnapshot();
    const input = {
      schemaVersion: 1,
      compositionId: "TimelineV1",
      renderVersion: this.renderVersion,
      correlationId: requestId,
      props: {
        timeline: snapshot,
        background: "#000000",
        components: [],
        captionStyle: { color: "#ffffff", background: "#000000", fontSize: 48, direction: "auto" },
      },
    };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '3s'");
      // Keep role revocation, source timeline mutation and project deletion ordered
      // with admission through the unchanged durable Job producer.
      const permission = await client.query(
        `SELECT t.id FROM editing_timelines t JOIN projects p ON p.id=t.project_id
         JOIN project_memberships m ON m.project_id=p.id
         WHERE t.id=$1 AND p.id=$2 AND p.deleted_at IS NULL AND m.user_id=$3
           AND m.role IN ('owner','editor') AND t.state_sha256=$4 FOR SHARE OF t,p,m`,
        [timeline.id, timeline.projectId, actor, contentHash(snapshot)],
      );
      if (permission.rowCount !== 1) throw new TimelineConflict();
      const result = await enqueueJob(this.deps, {
        id: createUuidV7(Date.now(), randomBytes(10)),
        queueName: "render-remotion-v1",
        jobType: "render.remotion",
        idempotencyKey: `render:${timeline.projectId}:${actor}:${requestId}`,
        payload: input,
        subject: { kind: "project", projectId: timeline.projectId },
        timeoutMs: 300_000,
        maxAttempts: 3,
        backoffBaseMs: 1000,
      });
      await client.query("COMMIT");
      const saved = await this.read(timeline.projectId, result.jobId);
      if (!saved) throw new ProjectNotFoundError();
      return saved.job;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof IdempotencyConflictError) throw new TimelineConflict();
      throw error;
    } finally {
      client.release();
    }
  }

  async read(project: Parameters<TimelineRenderJobs["read"]>[0], id: string) {
    const row = await this.deps.jobs.findById(jobId(id));
    if (
      !row ||
      row.jobType !== "render.remotion" ||
      row.subject.kind !== "project" ||
      row.subject.projectId !== project
    )
      return null;
    const version = row.payload["renderVersion"];
    if (
      row.payload["compositionId"] !== "TimelineV1" ||
      typeof version !== "string" ||
      version.length !== 64 ||
      !/^[a-f0-9]{64}$/.test(version)
    )
      return null;
    return {
      job: {
        jobId: row.id,
        status: row.status,
        attempt: row.attemptCount,
        updatedAt: String(row.updatedAt),
      },
      outputKey: row.status === "Completed" ? `renders/${version}/${project}/${row.id}.mp4` : null,
    };
  }

  async cancel(actor: UserId, project: Parameters<TimelineRenderJobs["read"]>[0], id: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '3s'");
      const allowed = await client.query(
        `SELECT p.id FROM projects p
        JOIN project_memberships m ON m.project_id=p.id WHERE p.id=$1 AND m.user_id=$2
        AND p.deleted_at IS NULL AND m.role IN ('owner','editor') FOR SHARE OF p,m`,
        [project, actor],
      );
      if (allowed.rowCount !== 1 || !(await this.read(project, id)))
        throw new ProjectNotFoundError();
      await cancelJob(this.deps, id);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

import type { Pool } from "pg";
import { instant, jobId, type JobQueue } from "@editagent/domain";
import { cancelJob, PostgresJobRepository } from "@editagent/job-queue";
import { RenderValidationV1Schema } from "@editagent/schemas";
import {
  AgentError,
  PlanningError,
  newAgentId,
  type AgentRenderPort,
  type AgentRenderRequest,
} from "@editagent/agent-core";
import { contentHash } from "@editagent/tool-sdk";

/** Isolated runner's existing authenticated API boundary. No model receives a
 * render tool, URL, session, storage key, filter or shell capability. */
export class AuthenticatedTimelineRenderPort implements AgentRenderPort {
  private readonly origin: string;
  constructor(
    private readonly pool: Pool,
    private readonly queue: JobQueue,
    origin: string,
    private readonly headersForActor: (actor: string) => Promise<Readonly<Record<string, string>>>,
  ) {
    const u = new URL(origin);
    if (
      process.env.NODE_ENV !== "test" ||
      process.env.EDITAGENT_REPLAY_QUALIFICATION !== "isolated-v1" ||
      u.protocol !== "http:" ||
      u.hostname !== "127.0.0.1" ||
      u.pathname !== "/" ||
      u.username ||
      u.password ||
      u.hash ||
      u.search
    )
      throw new AgentError("forbidden");
    this.origin = u.origin;
  }
  private async json(
    actor: string,
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    try {
      const res = await fetch(this.origin + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...(await this.headersForActor(actor)), "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]),
      });
      if (!res.ok || !res.body) throw new PlanningError("RENDER_FAILED");
      const reader = res.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > 16384) throw new PlanningError("RENDER_FAILED");
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new PlanningError("RENDER_FAILED");
      return value as Record<string, unknown>;
    } catch {
      throw new PlanningError("RENDER_FAILED");
    }
  }
  private requestId(receipt: string) {
    return "req_" + receipt.replaceAll("-", "");
  }
  private async admitted(input: AgentRenderRequest): Promise<void> {
    const result = await this.pool.query(
      `SELECT r.id FROM agent_runs r JOIN agent_loop_sessions s ON s.run_id=r.id
      WHERE r.id=$1 AND r.project_id=$2 AND r.actor_id=$3 AND r.runtime_driver='controlled-loop-v1'
      AND r.state='Rendering' AND s.render_receipt_id=$4 AND s.render_outcome='running'`,
      [input.runId, input.projectId, input.actorId, input.receiptId],
    );
    if (result.rowCount !== 1 || input.timeline.projectId !== input.projectId)
      throw new AgentError("fenced");
  }
  async start(input: AgentRenderRequest, signal: AbortSignal) {
    await this.admitted(input);
    const value = await this.json(
      input.actorId,
      `/projects/${input.projectId}/timelines/${input.timeline.id}/render`,
      signal,
      {
        stateSha256: contentHash(input.timeline.toSnapshot()),
        requestId: this.requestId(input.receiptId),
      },
    );
    if (typeof value.jobId !== "string") throw new PlanningError("RENDER_FAILED");
    return { jobId: value.jobId };
  }
  async reconcile(input: AgentRenderRequest, _signal: AbortSignal) {
    await this.admitted(input);
    const row = (
      await this.pool.query<{ id: string; payload: unknown }>(
        "SELECT id,payload FROM jobs WHERE job_type='render.remotion' AND subject_kind='project' AND subject_id=$1 AND idempotency_key=$2",
        [
          input.projectId,
          `render:${input.projectId}:${input.actorId}:${this.requestId(input.receiptId)}`,
        ],
      )
    ).rows[0];
    if (!row) return null;
    try {
      const payload = row.payload as { compositionId?: unknown; props?: { timeline?: unknown } };
      if (
        payload.compositionId !== "TimelineV1" ||
        contentHash(payload.props?.timeline) !== contentHash(input.timeline.toSnapshot())
      )
        throw new Error();
    } catch {
      throw new PlanningError("RENDER_UNCONFIRMED");
    }
    return { jobId: row.id };
  }
  async inspect(project: string, id: string, signal: AbortSignal) {
    const row = (
      await this.pool.query<{ actor_id: string }>(
        "SELECT r.actor_id FROM agent_runs r JOIN agent_loop_sessions s ON s.run_id=r.id WHERE r.project_id=$1 AND s.render_job_id=$2 AND r.runtime_driver='controlled-loop-v1'",
        [project, id],
      )
    ).rows[0];
    if (!row) throw new AgentError("not_found");
    const result = await this.json(row.actor_id, `/projects/${project}/exports/${id}`, signal);
    if (result.status === "Failed" || result.status === "Cancelled")
      return { status: "failed" as const };
    if (result.status !== "Completed") return { status: "pending" as const };
    const proof = RenderValidationV1Schema.safeParse(
      await this.json(row.actor_id, `/projects/${project}/exports/${id}/validation`, signal),
    );
    if (!proof.success) throw new PlanningError("OUTPUT_INVALID");
    return { status: "completed" as const, proof: proof.data };
  }
  async cancel(runId: string, project: string, id: string | null): Promise<void> {
    // A render may be accepted before its acknowledgement is persisted. Match
    // the exact durable receipt, actor and project; never enumerate or resubmit.
    const bound = await this.pool.query<{ id: string }>(
      `SELECT j.id FROM agent_runs r JOIN agent_loop_sessions s ON s.run_id=r.id
      JOIN jobs j ON j.idempotency_key='render:'||r.project_id::text||':'||r.actor_id::text||':req_'||replace(s.render_receipt_id::text,'-','')
      WHERE r.id=$1 AND r.project_id=$2 AND r.runtime_driver='controlled-loop-v1'
      AND ($3::uuid IS NULL OR j.id=$3) AND (s.render_job_id IS NULL OR s.render_job_id=j.id)
      AND j.subject_kind='project' AND j.subject_id=$2 AND j.job_type='render.remotion'`,
      [runId, project, id],
    );
    if (bound.rowCount === 0 && id === null) return;
    if (bound.rowCount !== 1) throw new AgentError("not_found");
    await cancelJob(
      {
        jobs: new PostgresJobRepository(this.pool),
        queue: this.queue,
        now: () => instant(BigInt(Date.now())),
        newAttemptId: newAgentId,
        supervisor: {
          async run() {
            throw new AgentError("forbidden");
          },
        },
      },
      jobId(bound.rows[0]!.id),
    );
  }
}

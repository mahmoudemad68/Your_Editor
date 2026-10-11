import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { projectId, uuidV7 } from "@editagent/domain";
import { enqueueJob, PermanentJobError, type RunJobDeps } from "@editagent/job-queue";
import { parseRenderInput, canonicalJson } from "./contract.js";
export const RENDER_JOB_TYPE = "render.remotion";
export const RENDER_QUEUE = "render-remotion-v1";
/** Trusted application producer boundary. No HTTP endpoint or user-supplied routing/key. */
export async function publishRenderJob(
  deps: RunJobDeps,
  pool: Pool,
  request: { jobId: string; projectId: string; actorId: string; input: unknown; timeoutMs: number },
) {
  const subject = projectId(request.projectId),
    actor = uuidV7(request.actorId),
    id = uuidV7(request.jobId),
    input = parseRenderInput(request.input);
  if (input.compositionId === "TimelineV1" && input.props.timeline.projectId !== subject)
    throw new PermanentJobError("Timeline project does not match subject.");
  const permission = await pool.query(
    "SELECT 1 FROM projects p JOIN project_memberships m ON m.project_id=p.id WHERE p.id=$1 AND p.deleted_at IS NULL AND m.user_id=$2 AND m.role IN ('owner','editor')",
    [subject, actor],
  );
  if (permission.rowCount !== 1) throw new PermanentJobError("Render project access denied.");
  if (
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1000 ||
    request.timeoutMs > 600000
  )
    throw new PermanentJobError("Invalid render timeout.");
  const signature = createHash("sha256").update(canonicalJson(input)).digest("hex");
  return enqueueJob(deps, {
    id,
    queueName: RENDER_QUEUE,
    jobType: RENDER_JOB_TYPE,
    idempotencyKey: `render:${subject}:${id}:${input.renderVersion}:${signature}`,
    payload: input as unknown as Record<string, unknown>,
    subject: { kind: "project", projectId: subject },
    timeoutMs: request.timeoutMs,
    maxAttempts: 3,
    backoffBaseMs: 1000,
  });
}

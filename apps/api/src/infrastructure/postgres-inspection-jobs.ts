import { jobId, type MediaAssetId } from "@editagent/domain";
import { requestMediaRevalidation, type RunJobDeps } from "@editagent/job-queue";
import type { ValidationPolicy } from "@editagent/shared";
import type { Pool } from "pg";
import type { InspectionJobs, InspectionJobSnapshot } from "../application/inspection-job.js";

export class PostgresInspectionJobs implements InspectionJobs {
  constructor(
    private readonly pool: Pool,
    private readonly deps: RunJobDeps,
    private readonly config: {
      queueName: string;
      policy: ValidationPolicy;
      newJobId: () => string;
    },
  ) {}
  async latest(mediaId: MediaAssetId): Promise<InspectionJobSnapshot | null> {
    const result = await this.pool.query<InspectionJobSnapshot>(
      `${SELECT} WHERE subject_kind = 'media-asset' AND subject_id = $1 AND job_type = 'media.inspect'
       AND NOT EXISTS (SELECT 1 FROM jobs successor
         WHERE successor.subject_kind = jobs.subject_kind AND successor.subject_id = jobs.subject_id
           AND successor.job_type = jobs.job_type
           AND right(successor.idempotency_key, 43) = '.after.' || jobs.id::text)
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [mediaId],
    );
    return result.rows[0] ?? null;
  }
  async retry(
    mediaId: MediaAssetId,
    predecessorId: string,
    correlationId: string,
  ): Promise<InspectionJobSnapshot> {
    const result = await requestMediaRevalidation(this.deps, {
      jobId: this.config.newJobId(),
      mediaAssetId: mediaId,
      previousJobId: predecessorId,
      correlationId,
      queueName: this.config.queueName,
      policy: this.config.policy,
    });
    const saved = await this.pool.query<InspectionJobSnapshot>(`${SELECT} WHERE id = $1`, [
      jobId(result.jobId),
    ]);
    if (!saved.rows[0]) throw new Error("The inspection retry was not persisted.");
    return saved.rows[0];
  }
}
// Select only public fields; the raw failure_reason and payload are never loaded.
const SELECT = `SELECT id::text AS "jobId", job_type AS "jobType", status, attempt_count AS attempt,
 CASE WHEN status = 'Failed' THEN 'processing_failed' WHEN status = 'Cancelled' THEN 'cancelled' ELSE NULL END AS reason,
 created_at::text AS "createdAt", updated_at::text AS "updatedAt", event_sequence::float8 AS sequence FROM jobs`;

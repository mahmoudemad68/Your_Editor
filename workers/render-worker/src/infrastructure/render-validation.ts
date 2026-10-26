import type { Pool } from "pg";
import type { JobEnvelope } from "@editagent/domain";
import { PermanentJobError } from "@editagent/job-queue";
import { RenderValidationV1Schema } from "@editagent/schemas";
import { contentHash } from "@editagent/tool-sdk";
import type { RenderArtifact, RenderInput } from "../application/ports.js";

export class PostgresRenderValidation {
  constructor(private readonly pool: Pool) {}
  async record(envelope: JobEnvelope, input: RenderInput, artifact: RenderArtifact): Promise<void> {
    if (input.compositionId !== "TimelineV1") return;
    const parsed = RenderValidationV1Schema.safeParse(artifact.validation);
    if (!parsed.success) throw new PermanentJobError("render_validation_missing");
    const proof = parsed.data;
    if (
      proof.jobId !== envelope.jobId ||
      proof.artifactSha256 !== artifact.sha256 ||
      proof.inputSha256 !== artifact.inputSha256 ||
      proof.timelineSha256 !== contentHash(input.props.timeline) ||
      proof.renderVersion !== input.renderVersion
    )
      throw new PermanentJobError("render_validation_mismatch");
    const saved = await this.pool.query(
      `WITH admitted AS (
      SELECT id,subject_id FROM jobs WHERE id=$1 AND job_type='render.remotion' AND subject_kind='project'
      AND subject_id=$2 AND status='Running' AND attempt_count=$3 FOR SHARE)
      INSERT INTO render_output_validations(job_id,project_id,proof) SELECT id,subject_id,$4::jsonb FROM admitted
      ON CONFLICT DO NOTHING RETURNING job_id`,
      [envelope.jobId, envelope.subject.id, envelope.attempt, JSON.stringify(proof)],
    );
    if (saved.rowCount === 1) return;
    const prior = (
      await this.pool.query<{ proof: unknown }>(
        "SELECT proof FROM render_output_validations WHERE job_id=$1 AND project_id=$2",
        [envelope.jobId, envelope.subject.id],
      )
    ).rows[0];
    if (!prior || contentHash(prior.proof) !== contentHash(proof))
      throw new PermanentJobError("render_validation_fenced");
  }
}

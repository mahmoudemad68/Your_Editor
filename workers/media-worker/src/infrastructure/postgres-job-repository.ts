/**
 * Postgres history for Job and JobAttempt. SQL stores rows.
 * Status changes are decided by the Job aggregate before save.
 */

import {
  Job,
  type JobAttempt,
  JobAttempt as JobAttemptRecord,
  type JobDeadLetter,
  type JobId,
  type JobRepository,
} from "@editagent/domain";
import { type Pool } from "pg";

interface JobRow {
  id: string;
  queue_name: string;
  job_type: string;
  idempotency_key: string;
  status: string;
  subject_kind: string;
  subject_id: string;
  timeout_ms: number;
  max_attempts: number;
  attempt_count: number;
  failure_reason: string | null;
  payload: unknown;
  created_at: string;
  updated_at: string;
}

interface AttemptRow {
  id: string;
  job_id: string;
  attempt_number: number;
  status: string;
  started_at: string;
  finished_at: string | null;
  reason: string | null;
}

export class PostgresJobRepository implements JobRepository {
  constructor(private readonly pool: Pool) {}

  async findById(id: JobId): Promise<Job | null> {
    const result = await this.pool.query<JobRow>(JOB_SELECT + " WHERE id = $1", [id]);
    const row = result.rows[0];
    return row === undefined ? null : restoreJob(row);
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<Job | null> {
    const result = await this.pool.query<JobRow>(JOB_SELECT + " WHERE idempotency_key = $1", [
      idempotencyKey,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : restoreJob(row);
  }

  async save(job: Job): Promise<void> {
    const snapshot = job.toSnapshot();
    const subjectId = subjectIdOf(job);
    await this.pool.query(
      `INSERT INTO jobs (
         id, queue_name, job_type, idempotency_key, status, subject_kind, subject_id,
         payload, timeout_ms, max_attempts, attempt_count, failure_reason, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14
       )
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         attempt_count = EXCLUDED.attempt_count,
         failure_reason = EXCLUDED.failure_reason,
         updated_at = EXCLUDED.updated_at`,
      [
        snapshot.id,
        snapshot.queueName,
        snapshot.jobType,
        snapshot.idempotencyKey,
        snapshot.status,
        snapshot.subject.kind,
        subjectId,
        JSON.stringify(snapshot.payload ?? {}),
        snapshot.timeoutMs,
        snapshot.maxAttempts,
        snapshot.attemptCount,
        snapshot.failureReason,
        snapshot.createdAt.toString(),
        snapshot.updatedAt.toString(),
      ],
    );
  }

  async appendAttempt(attempt: JobAttempt): Promise<void> {
    const snapshot = attempt.toSnapshot();
    await this.pool.query(
      `INSERT INTO job_attempts (
         id, job_id, attempt_number, status, started_at, finished_at, reason
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (job_id, attempt_number) DO UPDATE SET
         status = EXCLUDED.status,
         finished_at = EXCLUDED.finished_at,
         reason = EXCLUDED.reason`,
      [
        snapshot.id,
        snapshot.jobId,
        snapshot.attemptNumber,
        snapshot.status,
        snapshot.startedAt.toString(),
        snapshot.finishedAt == null ? null : snapshot.finishedAt.toString(),
        snapshot.reason,
      ],
    );
  }

  async listAttempts(id: JobId): Promise<readonly JobAttempt[]> {
    const result = await this.pool.query<AttemptRow>(
      `SELECT id::text AS id, job_id::text AS job_id, attempt_number, status,
              started_at::text AS started_at, finished_at::text AS finished_at, reason
       FROM job_attempts WHERE job_id = $1 ORDER BY attempt_number`,
      [id],
    );
    return result.rows.map(
      (row) =>
        new JobAttemptRecord(
          row.id,
          row.job_id,
          row.attempt_number,
          row.status,
          row.started_at,
          row.finished_at,
          row.reason,
        ),
    );
  }

  async saveDeadLetter(letter: JobDeadLetter): Promise<void> {
    await this.pool.query(
      `INSERT INTO job_dead_letters (job_id, reason, envelope, created_at)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (job_id) DO UPDATE SET reason = EXCLUDED.reason, envelope = EXCLUDED.envelope`,
      [letter.jobId, letter.reason, letter.envelopeJson, letter.createdAt.toString()],
    );
  }

  async findDeadLetter(id: JobId): Promise<JobDeadLetter | null> {
    const result = await this.pool.query<{ reason: string; envelope: unknown; created_at: string }>(
      `SELECT reason, envelope, created_at::text AS created_at
       FROM job_dead_letters WHERE job_id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      jobId: id,
      reason: row.reason,
      envelopeJson: JSON.stringify(row.envelope),
      createdAt: BigInt(row.created_at),
    };
  }
}

const JOB_SELECT = `SELECT id::text AS id, queue_name, job_type, idempotency_key, status,
  subject_kind, subject_id::text AS subject_id, payload, timeout_ms, max_attempts, attempt_count,
  failure_reason, created_at::text AS created_at, updated_at::text AS updated_at
  FROM jobs`;

function restoreJob(row: JobRow): Job {
  return Job.restore({
    id: row.id,
    subject: subjectFrom(row.subject_kind, row.subject_id),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    failureReason: row.failure_reason,
    attemptCount: row.attempt_count,
    queueName: row.queue_name,
    jobType: row.job_type,
    idempotencyKey: row.idempotency_key,
    timeoutMs: row.timeout_ms,
    maxAttempts: row.max_attempts,
    payload: payloadFrom(row.payload),
  });
}

function payloadFrom(value: unknown): Readonly<Record<string, unknown>> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }
  return {};
}

function subjectFrom(
  kind: string,
  id: string,
): {
  readonly kind: string;
  readonly projectId?: string;
  readonly mediaAssetId?: string;
  readonly derivedAssetId?: string;
} {
  if (kind === "project") {
    return { kind: "project", projectId: id };
  }
  if (kind === "media-asset") {
    return { kind: "media-asset", mediaAssetId: id };
  }
  return { kind: "derived-asset", derivedAssetId: id };
}

function subjectIdOf(job: Job): string {
  if (job.subject.kind === "project") {
    return job.subject.projectId;
  }
  if (job.subject.kind === "media-asset") {
    return job.subject.mediaAssetId;
  }
  return job.subject.derivedAssetId;
}

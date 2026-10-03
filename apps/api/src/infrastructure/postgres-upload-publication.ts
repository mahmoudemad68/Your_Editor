/**
 * Transactional outbox for media.inspect.
 * The asset and the intent commit together. Broker delivery is retried later
 * through the existing enqueueJob path. Replay keeps the same job id.
 */

import {
  MediaAsset,
  MediaAssetConflict,
  mediaAssetId,
  type JobQueue,
  type JobRepository,
} from "@editagent/domain";
import {
  MEDIA_INSPECT_BACKOFF_MS,
  MEDIA_INSPECT_JOB_TYPE,
  MEDIA_INSPECT_MAX_ATTEMPTS,
  MEDIA_INSPECT_TIMEOUT_MS,
  publishMediaInspectJob,
} from "@editagent/job-queue";
import { type Pool, type PoolClient } from "pg";

import { type UploadPublication } from "../application/uploads.js";
import { PostgresMediaAssetRepository } from "./postgres-media-repository.js";

const LEASE_MS = 15_000;
const RETRY_BASE_MS = 100;
const RETRY_CAP_MS = 5_000;

export class PublicationDeadlineError extends Error {
  constructor() {
    super("inspect publication deadline exceeded");
    this.name = "PublicationDeadlineError";
  }
}

/** Leaves the outbox lease in place so another dispatcher can recover it. */
export class DispatcherCrash extends Error {
  constructor() {
    super("dispatcher crashed after broker publication");
    this.name = "DispatcherCrash";
  }
}

export interface OutboxRecord {
  readonly jobId: string;
  readonly mediaAssetId: string;
  readonly correlationId: string;
  readonly queueName: string;
  readonly jobType: string;
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly status: string;
  readonly attemptCount: number;
  readonly lastError: string | null;
  readonly availableAt: string;
}

interface OutboxRow {
  job_id: string;
  media_asset_id: string;
  correlation_id: string;
  queue_name: string;
  job_type: string;
  idempotency_key: string;
  timeout_ms: number;
  max_attempts: number;
  backoff_base_ms: number;
  status: string;
  attempt_count: number;
  last_error: string | null;
  available_at: string;
}

export interface UploadPublicationOptions {
  readonly pool: Pool;
  readonly jobs: JobRepository;
  readonly queue: JobQueue;
  readonly now: () => bigint;
  readonly newJobId: () => string;
  readonly newAttemptId: () => string;
  readonly queueName: string;
  readonly deadlineMs?: number;
  readonly workerId?: string;
  readonly beforeCommit?: () => Promise<void>;
  readonly publish?: (record: OutboxRecord) => Promise<void>;
}

export class PostgresUploadPublication implements UploadPublication {
  private readonly deadlineMs: number;
  private readonly workerId: string;

  constructor(private readonly options: UploadPublicationOptions) {
    this.deadlineMs = options.deadlineMs ?? 2_000;
    this.workerId = options.workerId ?? "api-outbox";
  }

  async complete(asset: MediaAsset, correlationId: string): Promise<MediaAsset> {
    const stored = await this.record(asset, correlationId);
    try {
      await this.dispatchAsset(stored.id);
    } catch {
      // The intent is already durable. The recovery loop retries it.
    }
    return stored;
  }

  async dispatchDue(limit = 8): Promise<number> {
    const claimed = await this.claim(limit, null);
    let delivered = 0;
    for (const row of claimed) {
      if (await this.deliver(row)) {
        delivered += 1;
      }
    }
    return delivered;
  }

  async dispatchAsset(mediaAssetId: string): Promise<boolean> {
    const claimed = await this.claim(1, mediaAssetId);
    const row = claimed[0];
    if (row === undefined) {
      return false;
    }
    return this.deliver(row);
  }

  private async record(asset: MediaAsset, correlationId: string): Promise<MediaAsset> {
    const intent = this.intentFor(asset.id, correlationId);
    const client = await this.options.pool.connect();
    try {
      await client.query("BEGIN");
      await insertAsset(client, asset);
      await insertIntent(client, intent, this.options.now());
      if (this.options.beforeCommit) {
        await this.options.beforeCommit();
      }
      await client.query("COMMIT");
      return asset;
    } catch (error) {
      await client.query("ROLLBACK");
      if (!isUniqueViolation(error)) {
        throw error;
      }
    } finally {
      client.release();
    }
    return this.reconcile(asset, correlationId);
  }

  private async reconcile(incoming: MediaAsset, correlationId: string): Promise<MediaAsset> {
    const existing = await this.findByStorageKey(incoming);
    if (existing === null) {
      throw new MediaAssetConflict();
    }
    if (!sameUpload(existing, incoming)) {
      throw new MediaAssetConflict();
    }
    const intent = await this.findByAsset(existing.id);
    if (intent === null) {
      await this.insertMissingIntent(existing.id, correlationId);
    }
    return existing;
  }

  private async insertMissingIntent(mediaAssetId: string, correlationId: string): Promise<void> {
    const client = await this.options.pool.connect();
    try {
      await client.query("BEGIN");
      await insertIntent(client, this.intentFor(mediaAssetId, correlationId), this.options.now());
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (!isUniqueViolation(error)) {
        throw error;
      }
    } finally {
      client.release();
    }
  }

  private intentFor(mediaAssetId: string, correlationId: string) {
    return {
      jobId: this.options.newJobId(),
      mediaAssetId,
      correlationId,
      queueName: this.options.queueName,
      jobType: MEDIA_INSPECT_JOB_TYPE,
      idempotencyKey: `media.inspect.${mediaAssetId}`,
      timeoutMs: MEDIA_INSPECT_TIMEOUT_MS,
      maxAttempts: MEDIA_INSPECT_MAX_ATTEMPTS,
      backoffBaseMs: MEDIA_INSPECT_BACKOFF_MS,
    };
  }

  private async claim(limit: number, mediaAssetId: string | null): Promise<readonly OutboxRow[]> {
    const now = this.options.now().toString();
    const leaseUntil = (this.options.now() + BigInt(LEASE_MS)).toString();
    const result = await this.options.pool.query<OutboxRow>(
      `WITH due AS (
         SELECT job_id
         FROM inspect_publication_outbox
         WHERE (
           (status = 'Pending' AND available_at <= $1::bigint)
           OR (status = 'Delivering' AND lease_until <= $1::bigint)
         )
         AND ($4::uuid IS NULL OR media_asset_id = $4::uuid)
         ORDER BY available_at, job_id
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE inspect_publication_outbox AS outbox
       SET status = 'Delivering',
           lease_owner = $3,
           lease_until = $5::bigint,
           attempt_count = attempt_count + 1,
           updated_at = $1::bigint
       FROM due
       WHERE outbox.job_id = due.job_id
       RETURNING outbox.job_id::text AS job_id,
                 outbox.media_asset_id::text AS media_asset_id,
                 outbox.correlation_id,
                 outbox.queue_name,
                 outbox.job_type,
                 outbox.idempotency_key,
                 outbox.timeout_ms,
                 outbox.max_attempts,
                 outbox.backoff_base_ms,
                 outbox.status,
                 outbox.attempt_count,
                 outbox.last_error,
                 outbox.available_at::text AS available_at`,
      [now, limit, this.workerId, mediaAssetId, leaseUntil],
    );
    return result.rows;
  }

  private async deliver(row: OutboxRow): Promise<boolean> {
    try {
      await withDeadline(this.publish(toRecord(row)), this.deadlineMs);
      await this.markDelivered(row.job_id);
      return true;
    } catch (error) {
      if (error instanceof DispatcherCrash) {
        return false;
      }
      await this.markRetry(row, error);
      return false;
    }
  }

  private async publish(record: OutboxRecord): Promise<void> {
    if (this.options.publish) {
      await this.options.publish(record);
      return;
    }
    await publishMediaInspectJob(
      {
        jobs: this.options.jobs,
        queue: this.options.queue,
        supervisor: {
          async run(): Promise<void> {
            throw new Error("The API does not run jobs.");
          },
        },
        now: () => this.options.now(),
        newAttemptId: this.options.newAttemptId,
      },
      {
        jobId: record.jobId,
        mediaAssetId: record.mediaAssetId,
        correlationId: record.correlationId,
        queueName: record.queueName,
      },
    );
  }

  private async markDelivered(jobId: string): Promise<void> {
    const now = this.options.now().toString();
    await this.options.pool.query(
      `UPDATE inspect_publication_outbox
       SET status = 'Delivered',
           delivered_at = $2::bigint,
           lease_owner = NULL,
           lease_until = NULL,
           last_error = NULL,
           updated_at = $2::bigint
       WHERE job_id = $1::uuid AND lease_owner = $3 AND status = 'Delivering'`,
      [jobId, now, this.workerId],
    );
  }

  private async markRetry(row: OutboxRow, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : "inspect publication failed";
    const now = this.options.now();
    const delay = retryDelay(row.attempt_count);
    const availableAt = (now + BigInt(delay)).toString();
    await this.options.pool.query(
      `UPDATE inspect_publication_outbox
       SET status = 'Pending',
           lease_owner = NULL,
           lease_until = NULL,
           last_error = $2::text,
           error_history = CASE
             WHEN jsonb_array_length(error_history) >= 20
             THEN (error_history - 0) || jsonb_build_array(jsonb_build_object('at', $3::text, 'message', $2::text))
             ELSE error_history || jsonb_build_array(jsonb_build_object('at', $3::text, 'message', $2::text))
           END,
           available_at = $4::bigint,
           updated_at = $3::bigint
       WHERE job_id = $1::uuid AND lease_owner = $5 AND status = 'Delivering'`,
      [row.job_id, message, now.toString(), availableAt, this.workerId],
    );
  }

  private async findByAsset(mediaAssetId: string): Promise<OutboxRow | null> {
    const result = await this.options.pool.query<OutboxRow>(
      `SELECT job_id::text AS job_id, media_asset_id::text AS media_asset_id, correlation_id,
              queue_name, job_type, idempotency_key, timeout_ms, max_attempts, backoff_base_ms,
              status, attempt_count, last_error, available_at::text AS available_at
       FROM inspect_publication_outbox
       WHERE media_asset_id = $1::uuid`,
      [mediaAssetId],
    );
    return result.rows[0] ?? null;
  }

  private async findByStorageKey(incoming: MediaAsset): Promise<MediaAsset | null> {
    const result = await this.options.pool.query<{ id: string }>(
      `SELECT id::text AS id FROM media_assets WHERE project_id = $1::uuid AND storage_key = $2`,
      [incoming.projectId, incoming.storageKey ?? ""],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) {
      return null;
    }
    return new PostgresMediaAssetRepository(this.options.pool).findById(mediaAssetId(id));
  }
}

export function startPublicationRecovery(
  publication: PostgresUploadPublication,
  intervalMs = 200,
): { stop(): void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = (): void => {
    if (stopped) {
      return;
    }
    void publication
      .dispatchDue()
      .catch(() => undefined)
      .finally(() => {
        if (!stopped) {
          timer = setTimeout(tick, intervalMs);
        }
      });
  };
  timer = setTimeout(tick, intervalMs);
  return {
    stop(): void {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  };
}

function toRecord(row: OutboxRow): OutboxRecord {
  return {
    jobId: row.job_id,
    mediaAssetId: row.media_asset_id,
    correlationId: row.correlation_id,
    queueName: row.queue_name,
    jobType: row.job_type,
    idempotencyKey: row.idempotency_key,
    timeoutMs: row.timeout_ms,
    maxAttempts: row.max_attempts,
    backoffBaseMs: row.backoff_base_ms,
    status: row.status,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    availableAt: row.available_at,
  };
}

function sameUpload(stored: MediaAsset, incoming: MediaAsset): boolean {
  const left = stored.toSnapshot();
  const right = incoming.toSnapshot();
  return (
    left.storageKey === right.storageKey &&
    left.displayFilename === right.displayFilename &&
    left.mimeType === right.mimeType &&
    left.byteSize === right.byteSize &&
    left.contentSha256 === right.contentSha256
  );
}

async function insertAsset(client: PoolClient, asset: MediaAsset): Promise<void> {
  const snapshot = asset.toSnapshot();
  if (
    snapshot.storageKey == null ||
    snapshot.displayFilename == null ||
    snapshot.mimeType == null ||
    snapshot.byteSize == null ||
    snapshot.contentSha256 == null ||
    snapshot.uploadState == null
  ) {
    throw new Error("MediaAsset upload metadata is required.");
  }
  await client.query(
    `INSERT INTO media_assets (
       id, project_id, kind, storage_key, display_filename, mime_type, byte_size,
       content_sha256, upload_state, duration, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      snapshot.id,
      snapshot.projectId,
      snapshot.kind,
      snapshot.storageKey,
      snapshot.displayFilename,
      snapshot.mimeType,
      snapshot.byteSize.toString(),
      snapshot.contentSha256,
      snapshot.uploadState,
      snapshot.duration === null ? null : snapshot.duration.toString(),
      snapshot.createdAt.toString(),
      snapshot.updatedAt.toString(),
    ],
  );
}

async function insertIntent(
  client: PoolClient,
  intent: {
    jobId: string;
    mediaAssetId: string;
    correlationId: string;
    queueName: string;
    jobType: string;
    idempotencyKey: string;
    timeoutMs: number;
    maxAttempts: number;
    backoffBaseMs: number;
  },
  now: bigint,
): Promise<void> {
  await client.query(
    `INSERT INTO inspect_publication_outbox (
       job_id, media_asset_id, correlation_id, queue_name, job_type, idempotency_key,
       timeout_ms, max_attempts, backoff_base_ms, status, attempt_count, error_history,
       available_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, 'Pending', 0, '[]'::jsonb,
       $10, $10, $10
     )`,
    [
      intent.jobId,
      intent.mediaAssetId,
      intent.correlationId,
      intent.queueName,
      intent.jobType,
      intent.idempotencyKey,
      intent.timeoutMs,
      intent.maxAttempts,
      intent.backoffBaseMs,
      now.toString(),
    ],
  );
}

function retryDelay(attemptCount: number): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 8);
  return Math.min(RETRY_BASE_MS * 2 ** exponent, RETRY_CAP_MS);
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new PublicationDeadlineError());
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

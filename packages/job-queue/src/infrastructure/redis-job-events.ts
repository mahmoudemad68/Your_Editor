import { randomUUID } from "node:crypto";
import {
  type JobEvent,
  type JobEventPublisher,
  type JobEventSubscriber,
  type JobEventSubscription,
  type JobProgressEvent,
  assertJobProgress,
} from "@editagent/domain";
import { jobEventSchema } from "@editagent/schemas";
import { acceptCorrelationId, createServiceLogger, type JsonLogger } from "@editagent/shared";
import Ajv2020 from "ajv/dist/2020.js";
import { Redis } from "ioredis";
import { Pool } from "pg";

export const JOB_PROGRESS_WINDOW_MS = 200;
export function projectJobChannel(projectId: string): string {
  return `editagent:project-job-events:${projectId}`;
}
interface Pending {
  latest: JobProgressEvent;
  last: JobProgressEvent;
  timer?: ReturnType<typeof setTimeout> | undefined;
}
/** Cross-process ordering is serialized by a PG session advisory lock. The cursor
 * commits before publish, so outages leave gaps, never reused sequence numbers. */
export class RedisJobEventPublisher implements JobEventPublisher {
  private readonly redis: Redis;
  private readonly pool: Pool;
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  constructor(
    sourcePool: Pool,
    redisUrl: string,
    private readonly logger: JsonLogger = createServiceLogger("job-events"),
  ) {
    this.pool = new Pool({
      ...sourcePool.options,
      max: 2,
      connectionTimeoutMillis: 250,
      query_timeout: 250,
      statement_timeout: 250,
    });
    this.pool.on("error", () =>
      this.logger.warn({ eventKind: "connection" }, "job.events.transport.failed"),
    );
    this.redis = new Redis(redisUrl, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 200,
      connectTimeout: 500,
    });
    this.redis.on("error", () => undefined);
  }
  async progress(jobId: string, event: JobProgressEvent): Promise<void> {
    assertJobProgress(event);
    if (this.closed) return;
    const prior = this.pending.get(jobId);
    if (prior && prior.last.attempt === event.attempt && event.percentage < prior.latest.percentage)
      return;
    if (prior && prior.last.attempt === event.attempt && prior.last.stage === event.stage) {
      prior.latest = event;
      return;
    }
    if (prior?.timer) clearTimeout(prior.timer);
    const entry: Pending = { latest: event, last: event };
    this.pending.set(jobId, entry);
    try {
      await this.publish(jobId, event);
    } finally {
      this.arm(jobId, entry);
    }
  }
  private arm(jobId: string, entry: Pending): void {
    if (this.closed || this.pending.get(jobId) !== entry) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (this.pending.get(jobId) !== entry) return;
      this.pending.delete(jobId);
      if (entry.latest !== entry.last)
        void this.publish(jobId, entry.latest).catch(() => undefined);
    }, JOB_PROGRESS_WINDOW_MS);
    entry.timer.unref();
  }
  async flush(jobId: string): Promise<void> {
    const entry = this.pending.get(jobId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.pending.delete(jobId);
    if (entry && entry.latest !== entry.last) await this.publish(jobId, entry.latest);
  }
  async state(jobId: string): Promise<void> {
    if (this.closed) return;
    try {
      await this.flush(jobId);
    } catch {
      /* Still attempt the higher-priority state notification. */
    }
    await this.publish(jobId);
  }
  private async publish(jobId: string, progress?: JobProgressEvent): Promise<void> {
    const client = await this.pool.connect().catch(() => {
      this.logger.warn(
        { jobId, eventKind: progress ? "progress" : "state" },
        "job.events.transport.failed",
      );
      throw new Error("Job event publication unavailable.");
    });
    let locked = false;
    let correlationId: string | null = null;
    try {
      // Nonblocking lock: transport contention must not hold job execution forever.
      const deadline = Date.now() + 250;
      do {
        const lock = await client.query<{ ok: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1, 130)) AS ok",
          [jobId],
        );
        locked = lock.rows[0]?.ok === true;
        if (!locked) await new Promise((resolve) => setTimeout(resolve, 5));
      } while (!locked && Date.now() < deadline);
      if (!locked) throw new Error("Event transport busy.");
      const row = (
        await client.query<{
          id: string;
          job_type: string;
          project_id: string | null;
          status: string;
          attempt_count: number;
          event_progress_attempt: number;
          event_progress_percentage: number;
          payload: Record<string, unknown>;
          event_state_token: string | null;
        }>(
          `SELECT j.*, CASE j.subject_kind
        WHEN 'project' THEN p.id WHEN 'media-asset' THEN m.project_id
        WHEN 'derived-asset' THEN d.project_id END::text AS project_id
        FROM jobs j
        LEFT JOIN projects p ON j.subject_kind = 'project' AND p.id = j.subject_id AND p.deleted_at IS NULL
        LEFT JOIN media_assets m ON j.subject_kind = 'media-asset' AND m.id = j.subject_id
        LEFT JOIN derived_assets d ON j.subject_kind = 'derived-asset' AND d.id = j.subject_id
        WHERE j.id = $1`,
          [jobId],
        )
      ).rows[0];
      if (!row?.project_id || !/^[a-z][a-z0-9.-]{0,63}$/.test(row.job_type))
        throw new Error("Event ownership unavailable.");
      if (progress && (row.status !== "Running" || progress.attempt !== row.attempt_count)) return;
      if (
        progress &&
        row.event_progress_attempt === progress.attempt &&
        progress.percentage < row.event_progress_percentage
      )
        return;
      const token = `${row.status}:${row.attempt_count}`;
      if (!progress && row.event_state_token === token) return;
      const seq = (
        await client.query<{ event_sequence: string }>(
          `UPDATE jobs SET event_sequence = event_sequence + 1,
        event_state_token = CASE WHEN $2 THEN event_state_token ELSE $3 END,
        event_progress_attempt = CASE WHEN $2 THEN $4 ELSE event_progress_attempt END,
        event_progress_percentage = CASE WHEN $2 THEN $5 ELSE event_progress_percentage END
        WHERE id = $1 RETURNING event_sequence::text`,
          [jobId, progress !== undefined, token, progress?.attempt ?? 0, progress?.percentage ?? 0],
        )
      ).rows[0];
      if (!seq) throw new Error("Job disappeared.");
      const sequence = Number(seq.event_sequence);
      const raw = row.payload["correlationId"];
      correlationId = typeof raw === "string" ? acceptCorrelationId(raw) : null;
      const base = {
        schemaVersion: 1 as const,
        eventId: `${jobId}:${sequence}`,
        jobId,
        jobType: row.job_type,
        projectId: row.project_id,
        sequence,
        attempt: row.attempt_count,
        occurredAt: new Date().toISOString(),
        ...(correlationId ? { correlationId } : {}),
      };
      const event = progress
        ? { ...base, kind: "progress", percentage: progress.percentage, stage: progress.stage }
        : {
            ...base,
            kind: "state",
            status: row.status,
            ...(row.status === "Failed"
              ? { reason: "processing_failed" }
              : row.status === "Cancelled"
                ? { reason: "cancelled" }
                : {}),
          };
      if (this.redis.status !== "ready")
        await new Promise<void>((resolve, reject) => {
          const ready = () => {
            clearTimeout(timeout);
            resolve();
          };
          const timeout = setTimeout(() => {
            this.redis.removeListener("ready", ready);
            reject(new Error("Transport unavailable."));
          }, 250);
          this.redis.once("ready", ready);
        });
      const encoded = JSON.stringify(event);
      try {
        await this.redis.publish(projectJobChannel(row.project_id), encoded);
      } catch {
        await this.redis.publish(projectJobChannel(row.project_id), encoded);
      }
    } catch {
      this.logger.warn(
        {
          jobId,
          eventKind: progress ? "progress" : "state",
          ...(correlationId ? { correlationId } : {}),
        },
        "job.events.transport.failed",
      );
      throw new Error("Job event publication unavailable.");
    } finally {
      if (locked) {
        try {
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 130))", [jobId]);
        } catch {
          client.release(true);
        }
      }
      try {
        client.release();
      } catch {
        /* Failed unlock already destroyed this connection. */
      }
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pending = [...this.pending];
    this.pending.clear();
    for (const [, entry] of pending) if (entry.timer) clearTimeout(entry.timer);
    for (const [jobId, entry] of pending)
      if (entry.latest !== entry.last) {
        try {
          await this.publish(jobId, entry.latest);
        } catch {
          /* logged, observational */
        }
      }
    this.redis.disconnect();
    await this.pool.end();
  }
}

/** One shared dedicated subscriber connection; one Redis listener regardless of browsers. */
export class RedisJobEventSubscriber implements JobEventSubscriber {
  readonly connectionName = `job-events-${randomUUID()}`;
  private readonly redis: Redis;
  private readonly receivers = new Map<string, Set<(event: JobEvent) => void>>();
  private readonly validate = new Ajv2020({ strict: false }).compile(jobEventSchema);
  private closed = false;
  private operations: Promise<unknown> = Promise.resolve();
  constructor(
    redisUrl: string,
    private readonly logger: JsonLogger = createServiceLogger("api"),
  ) {
    this.redis = new Redis(redisUrl, {
      connectionName: this.connectionName,
      maxRetriesPerRequest: 1,
      commandTimeout: 500,
      connectTimeout: 500,
    });
    this.redis.on("error", () =>
      this.logger.warn({ eventKind: "subscription" }, "job.events.transport.failed"),
    );
    this.redis.on("message", (channel, raw) => {
      if (raw.length > 4096) return;
      try {
        const event: unknown = JSON.parse(raw);
        if (!this.validate(event)) return;
        const valid = event as unknown as JobEvent;
        if (
          channel !== projectJobChannel(valid.projectId) ||
          valid.eventId !== `${valid.jobId}:${valid.sequence}`
        )
          return;
        for (const receive of this.receivers.get(channel) ?? []) {
          try {
            receive(valid);
          } catch {
            /* One client cannot break delivery to others. */
          }
        }
      } catch {
        /* Malformed messages are ignored. */
      }
    });
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.operations.then(action, action);
    this.operations = next.catch(() => undefined);
    return next;
  }
  subscribe(projectId: string, receive: (event: JobEvent) => void): Promise<JobEventSubscription> {
    return this.serial(async () => {
      if (this.closed) throw new Error("Job event subscriber closed.");
      const channel = projectJobChannel(projectId);
      let set = this.receivers.get(channel);
      if (!set) {
        set = new Set();
        this.receivers.set(channel, set);
        try {
          await this.redis.subscribe(channel);
        } catch {
          this.receivers.delete(channel);
          throw new Error("Job events unavailable.");
        }
      }
      set.add(receive);
      let active = true;
      return {
        close: () =>
          this.serial(async () => {
            if (!active) return;
            active = false;
            set.delete(receive);
            if (set.size === 0) {
              this.receivers.delete(channel);
              if (!this.closed) await this.redis.unsubscribe(channel);
            }
          }),
      };
    });
  }
  get subscriptionCount(): number {
    return [...this.receivers.values()].reduce((n, set) => n + set.size, 0);
  }
  async close(): Promise<void> {
    this.closed = true;
    this.receivers.clear();
    this.redis.removeAllListeners("message");
    this.redis.disconnect();
  }
}

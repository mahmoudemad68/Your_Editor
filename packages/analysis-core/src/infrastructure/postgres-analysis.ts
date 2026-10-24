import { createHash, randomBytes } from "node:crypto";
import { createUuidV7, Job, jobId, mediaAssetId, instant, type JobQueue } from "@editagent/domain";
import { PostgresJobRepository, enqueueJob } from "@editagent/job-queue";
import {
  parseMediaAnalysis,
  migrateMediaAnalysisV1ToV1_1,
  validateMediaAnalysisV1_1,
  type MediaAnalysisV1_1,
} from "@editagent/schemas";
import { type Pool, type PoolClient } from "pg";
import {
  ANALYSIS_QUEUE,
  ANALYSIS_VERSION,
  withSection,
  type Analyzer,
  type AnalysisReader,
  type AnalysisSection,
} from "../contracts.js";

import { type AnalysisConfiguration } from "../configuration.js";
import {
  AnalysisAdmissionError,
  failureDetail,
  legacyAnalysisFailure,
  type AnalysisFailureCategory,
} from "../failures.js";

type Task = {
  job_id: string;
  media_asset_id: string;
  project_id: string;
  analyzer: Analyzer;
  generation: string;
  source_sha256: string;
  input_artifact_id: string;
  configuration_sha256: string;
  configuration: AnalysisConfiguration;
  result: unknown;
  failure: unknown;
  failure_category?: AnalysisFailureCategory | null;
  status: string;
  failure_reason?: string;
  applied: boolean;
  input_sha256: string;
  storage_key: string;
  duration: string;
  document: MediaAnalysisV1_1;
};

function currentVersion(document: unknown): MediaAnalysisV1_1 {
  const parsed = parseMediaAnalysis(document);
  return parsed.schemaVersion === "1.0.0" ? migrateMediaAnalysisV1ToV1_1(parsed) : parsed;
}
const newId = () => createUuidV7(Date.now(), randomBytes(10));
async function bounded<T>(operation: Promise<T>, milliseconds = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Analysis transport unavailable.")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function canonicalConfiguration(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalConfiguration).join(",") + "]";
  if (typeof value === "object" && value !== null)
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ":" +
            canonicalConfiguration((value as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  throw new Error("Invalid analysis configuration identity.");
}
export const configurationHash = (configuration: unknown) =>
  createHash("sha256").update(canonicalConfiguration(configuration)).digest("hex");

/** Source/result authority is PostgreSQL; Redis publication is recoverable at-least-once. */
export class PostgresAnalysis implements AnalysisReader {
  constructor(private readonly pool: Pool) {}
  async admissionFailure(id: string): Promise<"authorization_revoked" | "publication_fenced"> {
    const row = await this.pool.query<{ revoked: boolean }>(
      `SELECT t.initiated_by IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM project_memberships pm WHERE pm.project_id=a.project_id AND pm.user_id=t.initiated_by
      AND pm.role IN ('owner','editor')) AS revoked FROM analysis_tasks t JOIN media_analyses a ON a.media_asset_id=t.media_asset_id WHERE t.job_id=$1`,
      [id],
    );
    return row.rows[0]?.revoked ? "authorization_revoked" : "publication_fenced";
  }

  async failureDetails(assetId: string, projectId: string, sourceSha256: string) {
    const result = await this.pool.query<{
      analyzer: Analyzer;
      failure_category: unknown;
      status: string;
      failure_reason: string | null;
      failure: { retryable?: boolean } | null;
    }>(
      `SELECT DISTINCT ON(t.analyzer) t.analyzer,t.failure_category,t.failure,j.status,j.failure_reason
       FROM analysis_tasks t JOIN jobs j ON j.id=t.job_id JOIN media_analyses a ON a.media_asset_id=t.media_asset_id
       WHERE a.media_asset_id=$1 AND a.project_id=$2 AND a.source_sha256=$3
       ORDER BY t.analyzer,t.generation DESC`,
      [assetId, projectId, sourceSha256],
    );
    return {
      mediaAssetId: assetId,
      sourceSha256,
      failures: result.rows
        .filter((row) => row.status === "Failed" || row.status === "Cancelled")
        .map((row) => ({
          analyzer: row.analyzer,
          ...failureDetail(
            row.failure_category ??
              (row.failure_reason === "timed out"
                ? "timeout"
                : row.status === "Cancelled"
                  ? "cancelled"
                  : "internal"),
          ),
          retryable:
            row.failure_category === "analyzer_unavailable" && row.failure?.retryable === true,
        })),
    };
  }

  async scheduleDerivations(queue: JobQueue, queueName: string): Promise<void> {
    const jobs = new PostgresJobRepository(this.pool);
    const sources = await this.pool.query<{
      id: string;
      project_id: string;
    }>(`SELECT m.id,m.project_id FROM media_assets m JOIN projects p ON p.id=m.project_id
      WHERE m.validation_status='validated' AND p.deleted_at IS NULL AND m.kind='video' AND m.video_codec IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.idempotency_key='media.derive.'||m.project_id||'.'||m.id||'.us128-v1')
      ORDER BY m.id LIMIT 8`);
    for (const m of sources.rows) {
      await bounded(
        enqueueJob(
          {
            jobs,
            queue,
            now: () => instant(BigInt(Date.now())),
            newAttemptId: newId,
            supervisor: {
              async run() {
                throw new Error("Recovery does not execute jobs.");
              },
            },
          },
          {
            id: newId(),
            queueName,
            jobType: "media.derive",
            idempotencyKey: `media.derive.${m.project_id}.${m.id}.us128-v1`,
            subject: { kind: "media-asset", mediaAssetId: mediaAssetId(m.id) },
            payload: {
              version: "us128-v1",
              mediaAssetId: m.id,
              projectId: m.project_id,
              correlationId: "analysis-recovery",
            },
            timeoutMs: 1800000,
            maxAttempts: 3,
            backoffBaseMs: 1000,
          },
        ),
      );
    }
    const pending = await this.pool.query<{
      job_id: string;
    }>(`UPDATE analysis_derivation_publications SET lease_until_ms=
      (extract(epoch FROM clock_timestamp())*1000)::bigint+15000 WHERE job_id IN (
        SELECT o.job_id FROM analysis_derivation_publications o JOIN jobs j ON j.id=o.job_id WHERE j.status='Queued' AND lease_until_ms<
        (extract(epoch FROM clock_timestamp())*1000)::bigint ORDER BY o.job_id LIMIT 8 FOR UPDATE OF o SKIP LOCKED) RETURNING job_id`);
    for (const row of pending.rows) {
      const job = await jobs.findById(jobId(row.job_id));
      if (job?.status === "Queued")
        await bounded(
          queue.enqueue({
            id: job.id,
            queueName: job.queueName!,
            jobType: job.jobType!,
            idempotencyKey: job.idempotencyKey!,
            payload: job.payload,
            subject: job.subject,
            timeoutMs: job.timeoutMs!,
            maxAttempts: job.maxAttempts!,
            backoffBaseMs: 1000,
          }),
        );
      await this.pool.query(
        "UPDATE analysis_derivation_publications SET published=true WHERE job_id=$1",
        [row.job_id],
      );
    }
  }

  async read(assetId: string, projectId: string, sourceSha256: string) {
    const r = await this.pool.query<{ document: unknown }>(
      "SELECT document FROM media_analyses WHERE media_asset_id=$1 AND project_id=$2 AND source_sha256=$3",
      [assetId, projectId, sourceSha256],
    );
    return r.rows[0] ? parseMediaAnalysis(r.rows[0].document) : null;
  }

  async discover(configuration: AnalysisConfiguration, limit = 8): Promise<number> {
    const sources = await this.pool.query<{ id: string }>(
      `SELECT m.id FROM media_assets m
      JOIN projects p ON p.id=m.project_id WHERE m.validation_status='validated' AND p.deleted_at IS NULL AND m.kind='video'
      AND (m.audio_codec IS NULL OR EXISTS(SELECT 1 FROM derived_assets d WHERE d.media_asset_id=m.id
        AND d.kind='extracted-audio' AND d.metadata->>'variant'='asr') AND EXISTS(SELECT 1 FROM derived_assets d WHERE d.media_asset_id=m.id
        AND d.kind='extracted-audio' AND d.metadata->>'variant'='mix'))
      AND NOT EXISTS(SELECT 1 FROM media_analyses a WHERE a.media_asset_id=m.id)
      ORDER BY m.id LIMIT $1`,
      [limit],
    );
    let count = 0;
    for (const { id } of sources.rows) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout='5s'");
        const r = await client.query<Record<string, unknown>>(
          `SELECT m.* FROM media_assets m
          JOIN projects p ON p.id=m.project_id WHERE m.id=$1 AND m.validation_status='validated'
          AND p.deleted_at IS NULL FOR UPDATE OF m`,
          [id],
        );
        const m = r.rows[0];
        if (!m) {
          await client.query("ROLLBACK");
          continue;
        }
        const absent = { status: "not_available" } as const;
        const data: Record<string, unknown> = { kind: m["kind"] };
        for (const [column, field] of [
          ["duration", "durationUs"],
          ["container", "container"],
          ["video_codec", "videoCodec"],
          ["audio_codec", "audioCodec"],
          ["width", "width"],
          ["height", "height"],
          ["display_width", "displayWidth"],
          ["display_height", "displayHeight"],
          ["rotation", "rotation"],
          ["frame_rate_mode", "frameRateMode"],
          ["color_space", "colorSpace"],
          ["sample_rate", "sampleRate"],
          ["audio_channels", "audioChannels"],
        ])
          if (m[column!] != null)
            data[field!] = field === "durationUs" ? String(m[column!]) : m[column!];
        if (m["frame_rate_numerator"] != null && m["frame_rate_denominator"] != null)
          data["frameRate"] = {
            numerator: String(m["frame_rate_numerator"]),
            denominator: String(m["frame_rate_denominator"]),
          };
        const unsupported = {
          status: "failed",
          failure: {
            code: "unsupported",
            reason: "This analysis is unsupported.",
            retryable: false,
          },
        };
        const document = validateMediaAnalysisV1_1({
          schemaVersion: "1.1.0",
          mediaAssetId: id,
          source: {
            sha256: m["content_sha256"],
            ...(m["duration"] == null ? {} : { durationUs: String(m["duration"]) }),
          },
          provenance: { producer: "media-analysis", producerVersion: ANALYSIS_VERSION },
          sections: {
            metadata: {
              status: "completed",
              data,
              provenance: {
                analyzer: "media-inspection",
                analyzerVersion: "us126-v1",
                sourceSha256: m["content_sha256"],
                configurationSha256: configurationHash({ version: "us126-v1" }),
              },
            },
            transcript: m["audio_codec"] == null ? unsupported : absent,
            audio: m["audio_codec"] == null ? unsupported : absent,
            scenes: absent,
            faces: absent,
            objects: absent,
          },
        });
        const inserted = await client.query(
          `INSERT INTO media_analyses(media_asset_id,project_id,source_sha256,document)
          VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING media_asset_id`,
          [id, m["project_id"], m["content_sha256"], document],
        );
        if (inserted.rowCount) {
          if (m["audio_codec"] != null) {
            const d = await client.query<{ id: string; variant: string }>(
              `SELECT DISTINCT ON (metadata->>'variant') id,metadata->>'variant' AS variant FROM derived_assets WHERE media_asset_id=$1 AND
              kind='extracted-audio' AND metadata->>'variant' IN ('asr','mix') ORDER BY metadata->>'variant',created_at DESC,id`,
              [id],
            );
            if (d.rows.length !== 2 || m["duration"] == null)
              throw new Error("Verified analysis audio is unavailable.");
            for (const analyzer of ["transcript", "audio", "speech"] as const)
              await this.insertTask(
                client,
                id,
                analyzer,
                1,
                d.rows.find((row) => row.variant === (analyzer === "audio" ? "mix" : "asr"))!.id,
                configuration,
              );
          }
          count++;
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    return count;
  }

  private async insertTask(
    c: PoolClient,
    id: string,
    analyzer: Analyzer,
    generation: number,
    artifactId: string,
    configuration: AnalysisConfiguration,
    actorId?: string,
  ) {
    const hash = configurationHash(configuration);
    const job = Job.create(
      jobId(newId()),
      { kind: "media-asset", mediaAssetId: mediaAssetId(id) },
      instant(BigInt(Date.now())),
      {
        queueName: `${ANALYSIS_QUEUE}-${analyzer}`,
        jobType: `analysis.${analyzer}.v1`,
        idempotencyKey: `${ANALYSIS_VERSION}.${id}.${analyzer}.${hash}.${generation}`,
        timeoutMs: analyzer === "transcript" ? configuration.asr.timeout_ms : 600000,
        maxAttempts: 2,
        payload: {
          schemaVersion: 1,
          analysisVersion: ANALYSIS_VERSION,
          analyzer,
          mediaAssetId: id,
          inputArtifactId: artifactId,
          configurationSha256: hash,
          generation,
        },
      },
    );
    await c.query(
      `INSERT INTO jobs(id,queue_name,job_type,idempotency_key,status,subject_kind,subject_id,payload,
      timeout_ms,max_attempts,attempt_count,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
      [
        job.id,
        job.queueName,
        job.jobType,
        job.idempotencyKey,
        job.status,
        "media-asset",
        id,
        job.payload,
        job.timeoutMs,
        job.maxAttempts,
        job.attemptCount,
        job.createdAt.toString(),
      ],
    );
    await c.query(
      `INSERT INTO analysis_tasks(job_id,media_asset_id,analyzer,configuration_sha256,generation,input_artifact_id,configuration,deadline_at_ms,initiated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        job.id,
        id,
        analyzer,
        hash,
        generation,
        artifactId,
        configuration,
        (job.createdAt + BigInt(job.timeoutMs!)).toString(),
        actorId ?? null,
      ],
    );
  }

  async retry(
    id: string,
    projectId: string,
    analyzer: Analyzer,
    previousJobId: string,
    actorId?: string,
  ): Promise<string> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout='5s'");
      const locked = await c.query(
        "SELECT media_asset_id FROM media_analyses WHERE media_asset_id=$1 AND project_id=$2 FOR UPDATE",
        [id, projectId],
      );
      if (!locked.rowCount) throw new Error("Analysis is unavailable.");
      if (actorId) {
        const allowed = await c.query(
          `SELECT m.user_id FROM project_memberships m JOIN projects p ON p.id=m.project_id
          WHERE m.project_id=$1 AND m.user_id=$2 AND m.role IN ('owner','editor') AND p.deleted_at IS NULL FOR SHARE OF m,p`,
          [projectId, actorId],
        );
        if (!allowed.rowCount) throw new Error("Analysis retry permission denied.");
      }
      const r = await c.query<Task>(
        `SELECT t.*,j.status FROM analysis_tasks t JOIN jobs j ON j.id=t.job_id
        WHERE t.media_asset_id=$1 AND t.analyzer=$2 ORDER BY t.generation DESC LIMIT 1`,
        [id, analyzer],
      );
      const previous = r.rows[0];
      if (!previous) throw new Error("Analyzer is unavailable.");
      if (previous.job_id !== previousJobId) {
        const requested = await c.query<{ generation: string }>(
          "SELECT generation FROM analysis_tasks WHERE job_id=$1 AND media_asset_id=$2 AND analyzer=$3",
          [previousJobId, id, analyzer],
        );
        if (
          requested.rows[0] &&
          Number(previous.generation) === Number(requested.rows[0].generation) + 1
        ) {
          await c.query("COMMIT");
          return previous.job_id;
        }
        throw new Error("Stale analyzer predecessor.");
      }
      if (!["Completed", "Failed", "Cancelled"].includes(previous.status))
        throw new Error("Analyzer is still active.");
      await this.insertTask(
        c,
        id,
        analyzer,
        Number(previous.generation) + 1,
        previous.input_artifact_id,
        previous.configuration,
        actorId,
      );
      const current = await c.query<{ document: MediaAnalysisV1_1 }>(
        "SELECT document FROM media_analyses WHERE media_asset_id=$1",
        [id],
      );
      const pending = withSection(currentVersion(current.rows[0]!.document), analyzer, {
        status: "not_available",
      });
      await c.query(
        "UPDATE media_analyses SET document=$2,revision=revision+1 WHERE media_asset_id=$1",
        [id, pending],
      );
      const next = await c.query<{ job_id: string }>(
        "SELECT job_id FROM analysis_tasks WHERE media_asset_id=$1 AND analyzer=$2 ORDER BY generation DESC LIMIT 1",
        [id, analyzer],
      );
      await c.query("COMMIT");
      return next.rows[0]!.job_id;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }

  async input(id: string): Promise<Task | null> {
    const r = await this.pool.query<Task>(
      `SELECT t.*,j.status,a.project_id,a.source_sha256,a.document,
      d.content_sha256 AS input_sha256,d.storage_key,m.duration::text AS duration
      FROM analysis_tasks t JOIN jobs j ON j.id=t.job_id JOIN media_analyses a ON a.media_asset_id=t.media_asset_id
      JOIN derived_assets d ON d.id=t.input_artifact_id JOIN media_assets m ON m.id=a.media_asset_id
      JOIN projects p ON p.id=a.project_id WHERE t.job_id=$1 AND p.deleted_at IS NULL AND
      m.content_sha256=a.source_sha256 AND m.validation_status='validated'
      AND d.media_asset_id=m.id AND d.project_id=a.project_id AND
      (t.initiated_by IS NULL OR EXISTS(SELECT 1 FROM project_memberships pm WHERE pm.project_id=a.project_id
        AND pm.user_id=t.initiated_by AND pm.role IN ('owner','editor'))) AND
      NOT EXISTS(SELECT 1 FROM analysis_tasks n WHERE n.media_asset_id=t.media_asset_id AND n.analyzer=t.analyzer AND n.generation>t.generation)`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  async recordFailure(
    id: string,
    attempt: number,
    failure: Extract<AnalysisSection, { status: "failed" }>["failure"],
    category: AnalysisFailureCategory = "internal",
  ): Promise<void> {
    await this.pool.query(
      `UPDATE analysis_tasks SET failure=$3,failure_category=$4 WHERE job_id=$1 AND result IS NULL
      AND deadline_at_ms>(extract(epoch FROM clock_timestamp())*1000)::bigint AND EXISTS(SELECT 1 FROM jobs j
      WHERE j.id=job_id AND j.status='Running' AND j.attempt_count=$2)`,
      [id, attempt, failure, category],
    );
  }

  async clearAttemptFailure(id: string, attempt: number): Promise<void> {
    await this.pool.query(
      `UPDATE analysis_tasks SET failure=NULL,failure_category=NULL WHERE job_id=$1 AND result IS NULL
      AND EXISTS(SELECT 1 FROM jobs j WHERE j.id=job_id AND j.status='Running' AND j.attempt_count=$2)`,
      [id, attempt],
    );
  }

  async record(id: string, section: AnalysisSection, attempt: number): Promise<void> {
    const input = await this.input(id);
    if (!input) throw new AnalysisAdmissionError(await this.admissionFailure(id));
    const validated = withSection(currentVersion(input.document), input.analyzer, section).sections[
      input.analyzer === "speech" ? "audio" : input.analyzer
    ];
    const r = await this.pool.query(
      "UPDATE analysis_tasks SET result=$2,result_attempt=$3 WHERE job_id=$1 AND result IS NULL RETURNING job_id",
      [id, validated, attempt],
    );
    if (!r.rowCount && JSON.stringify(input.result) !== JSON.stringify(validated))
      throw new Error("Analysis result conflict.");
  }

  async recover(queue: JobQueue, limit = 8): Promise<void> {
    const jobs = new PostgresJobRepository(this.pool);
    const expired = await this.pool.query<{ job_id: string }>(
      `SELECT t.job_id FROM analysis_tasks t JOIN jobs j ON j.id=t.job_id
      WHERE t.deadline_at_ms<=(extract(epoch FROM clock_timestamp())*1000)::bigint AND j.status IN ('Queued','Retrying','Running') LIMIT $1`,
      [limit],
    );
    for (const { job_id: id } of expired.rows) {
      await bounded(queue.requestCancel(id), 1000).catch(() => undefined);
      const job = await jobs.findById(jobId(id));
      if (job && ["Queued", "Retrying", "Running"].includes(job.status)) {
        const cancelled = job.cancel(
          instant(BigInt(Math.max(Date.now(), Number(job.updatedAt) + 1))),
        );
        const c = await this.pool.connect();
        try {
          await c.query("BEGIN");
          await c.query("SET LOCAL lock_timeout='5s'");
          const changed = await c.query(
            `UPDATE jobs SET status='Cancelled',failure_reason=NULL,updated_at=$2
              WHERE id=$1 AND status=$3 AND updated_at=$4 RETURNING id`,
            [id, cancelled.updatedAt.toString(), job.status, job.updatedAt.toString()],
          );
          if (changed.rowCount) {
            await c.query(
              "UPDATE analysis_tasks SET failure=$2,failure_category='timeout' WHERE job_id=$1 AND result IS NULL",
              [id, { code: "timeout", reason: "Analysis timed out.", retryable: false }],
            );
            await c.query(
              `UPDATE job_attempts SET status='Cancelled',reason='cancelled',finished_at=$2
              WHERE job_id=$1 AND finished_at IS NULL`,
              [id, cancelled.updatedAt.toString()],
            );
          }
          await c.query("COMMIT");
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        } finally {
          c.release();
        }
      }
    }
    const claimed = await this.pool.query<{ job_id: string }>(
      `UPDATE analysis_tasks SET publication_lease_until_ms=
      (extract(epoch FROM clock_timestamp())*1000)::bigint+15000 WHERE job_id IN
      (SELECT t.job_id FROM analysis_tasks t JOIN jobs j ON j.id=t.job_id WHERE
        t.publication_lease_until_ms<(extract(epoch FROM clock_timestamp())*1000)::bigint AND j.status='Queued'
        ORDER BY t.job_id LIMIT $1 FOR UPDATE OF t SKIP LOCKED) RETURNING job_id`,
      [limit],
    );
    for (const { job_id: id } of claimed.rows) {
      const job = await jobs.findById(jobId(id));
      if (!job || job.status !== "Queued") continue;
      try {
        await bounded(
          queue.enqueue({
            id: job.id,
            queueName: job.queueName!,
            jobType: job.jobType!,
            idempotencyKey: job.idempotencyKey!,
            subject: job.subject,
            payload: job.payload,
            timeoutMs: job.timeoutMs!,
            maxAttempts: job.maxAttempts!,
            backoffBaseMs: 1000,
          }),
        );
      } catch {
        continue;
      }
      await this.pool.query("UPDATE analysis_tasks SET published=true WHERE job_id=$1", [id]);
    }
    const terminal = await this.pool.query<{ job_id: string }>(
      `SELECT t.job_id FROM analysis_tasks t JOIN jobs j ON j.id=t.job_id
      WHERE NOT t.applied AND j.status IN ('Completed','Failed','Cancelled') ORDER BY t.job_id LIMIT $1`,
      [limit],
    );
    for (const { job_id: id } of terminal.rows) {
      await this.applyTerminal(id);
      await bounded(queue.publishState?.(id) ?? Promise.resolve()).catch(() => undefined);
    }
  }

  private async applyTerminal(id: string) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout='5s'");
      const r = await c.query<Task>(
        `SELECT t.*,j.status,j.failure_reason,a.document FROM analysis_tasks t JOIN jobs j ON j.id=t.job_id
        JOIN media_analyses a ON a.media_asset_id=t.media_asset_id WHERE t.job_id=$1 FOR UPDATE OF a,t`,
        [id],
      );
      const t = r.rows[0];
      if (!t || t.applied) {
        await c.query("COMMIT");
        return;
      }
      const newer = await c.query(
        "SELECT 1 FROM analysis_tasks WHERE media_asset_id=$1 AND analyzer=$2 AND generation>$3",
        [t.media_asset_id, t.analyzer, t.generation],
      );
      // A cancelled/expired attempt must not inherit an earlier retry's failure.
      const category =
        t.status === "Cancelled"
          ? t.failure_category === "timeout"
            ? "timeout"
            : "cancelled"
          : t.failure_reason === "timed out"
            ? "timeout"
            : (t.failure_category ?? "internal");
      if (t.status !== "Completed") {
        t.failure_category = category;
        const previousRetryable =
          typeof t.failure === "object" &&
          t.failure !== null &&
          "retryable" in t.failure &&
          t.failure.retryable === true;
        t.failure = legacyAnalysisFailure(
          category,
          category === "analyzer_unavailable" && previousRetryable && t.status !== "Cancelled",
        );
        await c.query("UPDATE analysis_tasks SET failure=$2,failure_category=$3 WHERE job_id=$1", [
          id,
          t.failure,
          category,
        ]);
      }
      if (!newer.rowCount) {
        let section =
          t.status === "Completed" && t.result != null
            ? t.result
            : {
                status: "failed",
                failure: t.failure ?? {
                  code: t.failure_reason === "timed out" ? "timeout" : "unavailable",
                  reason:
                    t.failure_reason === "timed out"
                      ? "Analysis timed out."
                      : "Analyzer is unavailable.",
                  retryable: t.status !== "Cancelled" && t.failure_reason !== "timed out",
                },
              };
        if (t.analyzer !== "transcript") {
          const audio = await c.query<{
            analyzer: Analyzer;
            status: string;
            result: AnalysisSection | null;
            failure: unknown;
          }>(
            `SELECT DISTINCT ON(t.analyzer) t.analyzer,j.status,t.result,t.failure
            FROM analysis_tasks t JOIN jobs j ON j.id=t.job_id WHERE t.media_asset_id=$1 AND t.analyzer IN ('audio','speech')
            ORDER BY t.analyzer,t.generation DESC`,
            [t.media_asset_id],
          );
          if (audio.rows.some((r) => !["Completed", "Failed", "Cancelled"].includes(r.status))) {
            await c.query("COMMIT");
            return;
          }
          if (
            audio.rows.every((r) => r.status === "Completed" && r.result?.status === "completed")
          ) {
            const acoustic = audio.rows.find((r) => r.analyzer === "audio")!.result!;
            const speech = audio.rows.find((r) => r.analyzer === "speech")!.result!;
            if (acoustic.status !== "completed" || speech.status !== "completed")
              throw new Error("Invalid audio receipt.");
            section = {
              status: "completed",
              data: { ...acoustic.data, ...speech.data },
              provenance: acoustic.provenance,
            };
          } else
            section = {
              status: "failed",
              failure: audio.rows.find((r) => r.status !== "Completed")?.failure ?? {
                code: "unavailable",
                reason: "Analyzer is unavailable.",
                retryable: true,
              },
            };
        }
        const document = withSection(
          currentVersion(t.document),
          t.analyzer,
          section as AnalysisSection,
        );
        await c.query(
          "UPDATE media_analyses SET document=$2,revision=revision+1 WHERE media_asset_id=$1",
          [t.media_asset_id, document],
        );
      }
      await c.query("UPDATE analysis_tasks SET applied=true WHERE job_id=$1", [id]);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
}

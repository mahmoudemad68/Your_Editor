import {
  AnalysisAdmissionError,
  PostgresAnalysis,
  legacyAnalysisFailure,
  failureDetail,
  type AnalysisFailureCategory,
} from "@editagent/analysis-core";
import { FFmpegAudioAnalyzer, DEFAULT_AUDIO_ANALYSIS_CONFIG } from "@editagent/media-core";
import { type JobEnvelope } from "@editagent/domain";
import {
  BullMqJobQueue,
  RedisJobEventPublisher,
  PermanentJobError,
  JobTimeoutError,
  JobCancelledError,
} from "@editagent/job-queue";
import { Pool } from "pg";
import Ajv2020 from "ajv/dist/2020.js";
import { analysisJobSchema } from "@editagent/schemas";
import { loadMediaWorkerConfig } from "../infrastructure/config.js";
import { FileObjectStager } from "../infrastructure/object-stager.js";
import { S3ObjectByteSource, createMediaS3Client } from "../infrastructure/s3-object-stream.js";
import { assertValidationSandbox } from "../infrastructure/media-validator.js";

export function audioFailureCategory(error: unknown, signal: AbortSignal): AnalysisFailureCategory {
  const constraint =
    typeof error === "object" && error !== null && "constraint" in error
      ? error.constraint
      : undefined;
  if (constraint === "analysis_deadline") return "timeout";
  if (constraint === "analysis_result_admission") return "publication_fenced";
  if (
    signal.reason instanceof JobTimeoutError ||
    error instanceof JobTimeoutError ||
    (error instanceof DOMException && error.name === "TimeoutError")
  )
    return "timeout";
  if (signal.aborted || error instanceof JobCancelledError) return "cancelled";
  if (error instanceof AnalysisAdmissionError) return error.category;
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "EA001") return "authorization_revoked";
  if (code === "42501") return "authorization_failed";
  if (error instanceof PermanentJobError) return "invalid_input";
  const metadata =
    typeof error === "object" && error !== null && "$metadata" in error
      ? error.$metadata
      : undefined;
  if (
    typeof metadata === "object" &&
    metadata !== null &&
    "httpStatusCode" in metadata &&
    typeof metadata.httpStatusCode === "number" &&
    metadata.httpStatusCode >= 400
  )
    return "analyzer_unavailable";
  if (error instanceof Error && error.name === "TimeoutError") return "analyzer_unavailable";
  if (
    typeof code === "string" &&
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "08006", "08001", "57P01"].includes(
      code,
    )
  )
    return "analyzer_unavailable";
  return "internal";
}

export function audioFailureRetryable(error: unknown, category: AnalysisFailureCategory): boolean {
  const metadata =
    typeof error === "object" && error !== null && "$metadata" in error
      ? error.$metadata
      : undefined;
  const status =
    typeof metadata === "object" && metadata !== null && "httpStatusCode" in metadata
      ? metadata.httpStatusCode
      : undefined;
  return (
    category === "analyzer_unavailable" &&
    !(typeof status === "number" && status < 500 && status !== 429)
  );
}

export async function handleAudioAnalysis(
  envelope: JobEnvelope,
  signal: AbortSignal,
): Promise<void> {
  if (!new Ajv2020({ strict: true }).compile(analysisJobSchema)(envelope.payload))
    throw new PermanentJobError("Invalid analysis intent.");
  const config = loadMediaWorkerConfig();
  assertValidationSandbox();
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1, statement_timeout: 5000 });
  const store = new PostgresAnalysis(pool);
  const client = createMediaS3Client(config.objectStorage);
  const queue = new BullMqJobQueue(config.redisUrl, {
    events: new RedisJobEventPublisher(pool, config.redisUrl),
  });
  let staged: Awaited<ReturnType<FileObjectStager["stage"]>> | undefined;
  const execute = async () => {
    await store.clearAttemptFailure(envelope.jobId, envelope.attempt);
    const input = await store.input(envelope.jobId);
    if (!input) throw new AnalysisAdmissionError(await store.admissionFailure(envelope.jobId));
    if (
      !input ||
      input.analyzer !== "audio" ||
      envelope.jobType !== "analysis.audio.v1" ||
      envelope.subject.kind !== "media-asset" ||
      envelope.subject.id !== input.media_asset_id ||
      envelope.payload["configurationSha256"] !== input.configuration_sha256 ||
      envelope.payload["inputArtifactId"] !== input.input_artifact_id
    )
      throw new PermanentJobError("Invalid analysis intent.");
    if (input.result !== null) return;
    await queue.publishProgress(envelope.jobId, {
      stage: "staging",
      percentage: 0,
      attempt: envelope.attempt,
    });
    staged = await new FileObjectStager({
      source: new S3ObjectByteSource(client, config.objectStorage.bucket),
      maxBytes: 2n * 1024n * 1024n * 1024n,
    }).stage(input.storage_key, signal);
    if (staged.contentSha256 !== input.input_sha256)
      throw new PermanentJobError("Analysis audio identity mismatch.");
    await queue.publishProgress(envelope.jobId, {
      stage: "decoding",
      percentage: 10,
      attempt: envelope.attempt,
    });
    const result = await new FFmpegAudioAnalyzer(
      DEFAULT_AUDIO_ANALYSIS_CONFIG,
      config.ffmpegPath,
    ).analyze({
      filePath: staged.filePath,
      durationUs: BigInt(input.duration),
      sourceSha256: input.source_sha256,
      signal,
      inputSha256: input.input_sha256,
      inputArtifactId: input.input_artifact_id,
    });
    signal.throwIfAborted();
    await store.record(envelope.jobId, result, envelope.attempt);
    await queue.publishProgress(envelope.jobId, {
      stage: "finalizing",
      percentage: 100,
      attempt: envelope.attempt,
    });
  };
  let failure: unknown;
  try {
    await execute();
  } catch (error) {
    const permanent = error instanceof PermanentJobError;
    const category = audioFailureCategory(error, signal);
    const retryable = audioFailureRetryable(error, category);
    await store
      .recordFailure(
        envelope.jobId,
        envelope.attempt,
        legacyAnalysisFailure(category, retryable),
        category,
      )
      .catch(() => undefined);
    failure = signal.aborted
      ? signal.reason
      : permanent || !retryable
        ? new PermanentJobError(failureDetail(category).message)
        : new Error(failureDetail(category).message);
  }
  const cleanup = await Promise.allSettled([
    Promise.resolve().then(() => staged?.release()),
    Promise.resolve().then(() => client.destroy()),
    Promise.resolve().then(() => queue.close()),
    Promise.resolve().then(() => pool.end()),
  ]);
  const unconfirmed = cleanup.find((result) => result.status === "rejected");
  if (!failure && unconfirmed?.status === "rejected")
    failure = new Error("Analysis resource cleanup is unconfirmed.", { cause: unconfirmed.reason });
  if (failure) throw failure;
}

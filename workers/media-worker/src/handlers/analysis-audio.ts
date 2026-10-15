import { PostgresAnalysis } from "@editagent/analysis-core";
import { FFmpegAudioAnalyzer, DEFAULT_AUDIO_ANALYSIS_CONFIG } from "@editagent/media-core";
import { type JobEnvelope } from "@editagent/domain";
import { BullMqJobQueue, RedisJobEventPublisher, PermanentJobError } from "@editagent/job-queue";
import { Pool } from "pg";
import Ajv2020 from "ajv/dist/2020.js";
import { analysisJobSchema } from "@editagent/schemas";
import { loadMediaWorkerConfig } from "../infrastructure/config.js";
import { FileObjectStager } from "../infrastructure/object-stager.js";
import { S3ObjectByteSource, createMediaS3Client } from "../infrastructure/s3-object-stream.js";
import { assertValidationSandbox } from "../infrastructure/media-validator.js";

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
    const input = await store.input(envelope.jobId);
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
    await store
      .recordFailure(envelope.jobId, envelope.attempt, {
        code: permanent ? "invalid_input" : "unavailable",
        reason: permanent ? "Analysis input is invalid." : "Analyzer is unavailable.",
        retryable: !permanent,
      })
      .catch(() => undefined);
    failure = signal.aborted
      ? signal.reason
      : permanent
        ? Object.assign(new PermanentJobError("Analysis input is invalid."), { cause: error })
        : new Error("Analyzer is unavailable.", { cause: error });
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

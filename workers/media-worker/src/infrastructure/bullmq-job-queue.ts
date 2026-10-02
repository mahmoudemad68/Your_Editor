/**
 * BullMQ adapter for IJobQueue. BullMQ types do not leave this file.
 * Job data is the shared JSON envelope. Postgres remains the state record.
 */

import {
  type EnqueueJobCommand,
  type EnqueueJobResult,
  type JobEnvelope,
  type JobFailure,
  type JobProgressEvent,
  type JobQueue,
  type JobReceipt,
  type ReservedJob,
} from "@editagent/domain";
import { jobEnvelopeSchema } from "@editagent/schemas";
import { Queue, UnrecoverableError, Worker, type Job as BullJob } from "bullmq";
import { Redis } from "ioredis";
import Ajv2020 from "ajv/dist/2020.js";

const PREFIX = "bull";

export class BullMqJobQueue implements JobQueue {
  private readonly redisUrl: string;
  private readonly connection: Redis;
  private readonly queues = new Map<string, Queue>();
  private readonly workers = new Map<string, Worker>();
  private readonly inflight = new Map<string, BullJob>();
  private readonly validateEnvelope: (data: unknown) => boolean;
  private closed = false;

  constructor(redisUrl: string) {
    this.redisUrl = redisUrl;
    this.connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    this.validateEnvelope = ajv.compile(jobEnvelopeSchema);
  }

  async enqueue(command: EnqueueJobCommand): Promise<EnqueueJobResult> {
    const envelope = envelopeFrom(command, 1);
    assertEnvelope(this.validateEnvelope, envelope);
    const queue = this.queueFor(command.queueName);
    const prior = await queue.getJob(command.id);
    if (prior) {
      return { jobId: command.id, duplicate: true };
    }
    try {
      await queue.add(command.jobType, envelope, {
        jobId: command.id,
        attempts: command.maxAttempts,
        backoff: { type: "exponential", delay: command.backoffBaseMs },
        removeOnComplete: false,
        removeOnFail: false,
      });
    } catch (error) {
      if (!isDuplicateJob(error)) {
        throw error;
      }
      return { jobId: command.id, duplicate: true };
    }
    return { jobId: command.id, duplicate: false };
  }

  async reserve(queueName: string): Promise<ReservedJob | null> {
    const worker = await this.workerFor(queueName);
    await sweepStalled(worker);
    const token = `reserve-${crypto.randomUUID()}`;
    const job = await worker.getNextJob(token, { block: false });
    if (!job) {
      return null;
    }
    this.inflight.set(token, job);
    const attempt = job.attemptsStarted > 0 ? job.attemptsStarted : 1;
    const envelope = { ...(job.data as JobEnvelope), attempt };
    assertEnvelope(this.validateEnvelope, envelope);
    await job.updateData(envelope);
    return {
      receipt: { jobId: envelope.jobId, queueName, token },
      envelope,
    };
  }

  async complete(receipt: JobReceipt): Promise<void> {
    const job = this.takeInflight(receipt);
    await job.moveToCompleted("completed", receipt.token, false);
  }

  async fail(receipt: JobReceipt, failure: JobFailure): Promise<void> {
    const job = this.takeInflight(receipt);
    const error = failure.transient
      ? new Error(failure.reason)
      : new UnrecoverableError(failure.reason);
    await job.moveToFailed(error, receipt.token, false);
    if (!failure.transient) {
      await this.deadLetter(receipt.queueName, job);
    }
  }

  async requestCancel(jobId: string): Promise<void> {
    await this.connection.set(cancelKey(jobId), "1");
  }

  async isCancelRequested(jobId: string): Promise<boolean> {
    const value = await this.connection.get(cancelKey(jobId));
    return value === "1";
  }

  async discardQueued(jobId: string, queueName: string): Promise<void> {
    const queue = this.queueFor(queueName);
    const job = await queue.getJob(jobId);
    if (job && ((await job.isWaiting()) || (await job.isDelayed()))) {
      await job.remove();
    }
  }

  async publishProgress(jobId: string, event: JobProgressEvent): Promise<void> {
    await this.connection.publish(`editagent:job-progress:${jobId}`, event.message);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await Promise.all([...this.workers.values()].map((worker) => worker.close()));
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.workers.clear();
    this.queues.clear();
    await this.connection.quit();
  }

  private queueFor(queueName: string): Queue {
    const existing = this.queues.get(queueName);
    if (existing) {
      return existing;
    }
    const queue = new Queue(queueName, {
      connection: { url: this.redisUrl, maxRetriesPerRequest: null },
      prefix: PREFIX,
    });
    this.queues.set(queueName, queue);
    return queue;
  }

  private async workerFor(queueName: string): Promise<Worker> {
    const existing = this.workers.get(queueName);
    if (existing) {
      return existing;
    }
    const worker = new Worker(queueName, null, {
      connection: { url: this.redisUrl, maxRetriesPerRequest: null },
      prefix: PREFIX,
      autorun: false,
      lockDuration: 30_000,
      stalledInterval: 200,
      maxStalledCount: 5,
    });
    this.workers.set(queueName, worker);
    await worker.startStalledCheckTimer();
    return worker;
  }

  private takeInflight(receipt: JobReceipt): BullJob {
    const job = this.inflight.get(receipt.token);
    if (!job) {
      throw new Error(`Queue job ${receipt.jobId} is not reserved by this worker.`);
    }
    this.inflight.delete(receipt.token);
    return job;
  }

  private async deadLetter(queueName: string, job: BullJob): Promise<void> {
    const dead = this.queueFor(`${queueName}-dead-letter`);
    await dead.add("dead-letter", job.data, {
      jobId: `${String(job.id)}-dead`,
      removeOnComplete: false,
    });
  }
}

async function sweepStalled(worker: Worker): Promise<void> {
  // BullMQ types keep the sweep private. Manual workers must run it before reserve
  // so a crashed worker's active job can return to the wait list.
  await (worker as unknown as { moveStalledJobsToWait(): Promise<void> }).moveStalledJobsToWait();
}

function envelopeFrom(command: EnqueueJobCommand, attempt: number): JobEnvelope {
  return {
    schemaVersion: 1,
    jobId: command.id,
    queueName: command.queueName,
    jobType: command.jobType,
    idempotencyKey: command.idempotencyKey,
    payload: command.payload,
    timeoutMs: command.timeoutMs,
    maxAttempts: command.maxAttempts,
    attempt,
    backoffBaseMs: command.backoffBaseMs,
    subject: subjectOf(command),
  };
}

function subjectOf(command: EnqueueJobCommand): JobEnvelope["subject"] {
  if (command.subject.kind === "project") {
    return { kind: "project", id: command.subject.projectId };
  }
  if (command.subject.kind === "media-asset") {
    return { kind: "media-asset", id: command.subject.mediaAssetId };
  }
  return { kind: "derived-asset", id: command.subject.derivedAssetId };
}

function assertEnvelope(validate: (data: unknown) => boolean, envelope: JobEnvelope): void {
  if (!validate(envelope)) {
    throw new Error("Job envelope does not match the shared JSON Schema.");
  }
}

function isDuplicateJob(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message.includes("Job") && message.toLowerCase().includes("exist");
}

function cancelKey(jobId: string): string {
  return `editagent:job-cancel:${jobId}`;
}

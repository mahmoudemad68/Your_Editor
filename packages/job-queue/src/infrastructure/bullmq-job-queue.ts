/**
 * BullMQ adapter for IJobQueue. BullMQ types do not leave this file.
 * Job data is the shared JSON envelope. Postgres remains the state record.
 */

import {
  type EnqueueJobCommand,
  type EnqueueJobResult,
  type JobEnvelope,
  type JobEventPublisher,
  assertJobProgress,
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

import { InvalidJobEnvelopeError } from "../application/job-errors.js";

const PREFIX = "bull";

export interface BullMqJobQueueOptions {
  readonly events?: JobEventPublisher;
  readonly lockDurationMs?: number;
  readonly stalledIntervalMs?: number;
}

export class BullMqJobQueue implements JobQueue {
  private readonly redisUrl: string;
  private readonly connection: Redis;
  private readonly queues = new Map<string, Queue>();
  private readonly workers = new Map<string, Worker>();
  private readonly inflight = new Map<string, BullJob>();
  private readonly renewalTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly lockListeners = new Map<string, () => void>();
  private readonly lostTokens = new Set<string>();
  private readonly validateEnvelope: (data: unknown) => boolean;
  private readonly lockDurationMs: number;
  private readonly stalledIntervalMs: number;
  private closed = false;
  private readonly events: JobEventPublisher | undefined;

  constructor(redisUrl: string, options: BullMqJobQueueOptions = {}) {
    this.redisUrl = redisUrl;
    this.events = options.events;
    this.lockDurationMs = options.lockDurationMs ?? 30_000;
    this.stalledIntervalMs = options.stalledIntervalMs ?? 200;
    this.connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.connection.on("error", () => undefined);
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    this.validateEnvelope = ajv.compile(jobEnvelopeSchema);
  }

  async enqueue(command: EnqueueJobCommand): Promise<EnqueueJobResult> {
    const envelope = envelopeFrom(command, 1);
    assertEnvelope(this.validateEnvelope, envelope);
    await this.publishState(command.id);
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
    if (!this.validateEnvelope(envelope)) {
      await this.settleUnrecoverable(queueName, job, token);
      throw new InvalidJobEnvelopeError(String(job.id));
    }
    try {
      await this.persistReservedEnvelope(job, envelope);
    } catch (error) {
      await this.release({ jobId: envelope.jobId, queueName, token });
      throw error;
    }
    this.startRenewal(job, token);
    return {
      receipt: { jobId: envelope.jobId, queueName, token },
      envelope,
    };
  }

  whenLockLost(receipt: JobReceipt, notify: () => void): void {
    if (this.lostTokens.delete(receipt.token)) {
      notify();
      return;
    }
    this.lockListeners.set(receipt.token, notify);
  }

  async ownsReservation(receipt: JobReceipt): Promise<boolean> {
    if (this.lostTokens.has(receipt.token)) {
      return false;
    }
    const job = this.inflight.get(receipt.token);
    if (!job) {
      return false;
    }
    try {
      const extended = await job.extendLock(receipt.token, this.lockDurationMs);
      if (Number(extended) === 1) {
        return true;
      }
    } catch {
      // The lock command failed. The reservation is gone.
    }
    this.markLockLost(receipt.token);
    return false;
  }

  async complete(receipt: JobReceipt): Promise<void> {
    this.stopRenewal(receipt.token);
    const job = this.takeInflight(receipt);
    await job.moveToCompleted("completed", receipt.token, false);
  }

  async release(receipt: JobReceipt): Promise<void> {
    this.stopRenewal(receipt.token);
    const job = this.inflight.get(receipt.token);
    this.inflight.delete(receipt.token);
    if (!job) {
      await this.dropLock(receipt);
      return;
    }
    try {
      await job.moveToWait(receipt.token);
      return;
    } catch {
      // The lock may already be unusable. Fall through.
    }
    try {
      await job.moveToFailed(new Error("reservation released"), receipt.token, false);
      return;
    } catch {
      await this.dropLock(receipt);
    }
  }

  async fail(receipt: JobReceipt, failure: JobFailure): Promise<void> {
    this.stopRenewal(receipt.token);
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
    assertJobProgress(event);
    if (!this.events) throw new Error("Job events publisher is not configured.");
    try {
      await this.events.progress(jobId, event);
    } catch {
      /* Transport logs failure; work remains authoritative. */
    }
  }

  async flushProgress(jobId: string): Promise<void> {
    try {
      await this.events?.flush(jobId);
    } catch {
      /* Observational failure is already logged. */
    }
  }
  async publishState(jobId: string): Promise<void> {
    try {
      await this.events?.state(jobId);
    } catch {
      /* Observational failure cannot change work outcome. */
    }
  }

  async close(immediate = false): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.events?.close();
    for (const token of [...this.lockListeners.keys()]) this.markLockLost(token);
    for (const timer of this.renewalTimers.values()) {
      clearInterval(timer);
    }
    this.renewalTimers.clear();
    const closing = Promise.all([
      ...[...this.workers.values()].map((worker) => worker.close(immediate)),
      ...[...this.queues.values()].map((queue) => queue.close()),
    ]);
    this.workers.clear();
    this.queues.clear();
    if (immediate) {
      this.connection.disconnect();
      await Promise.race([closing.catch(() => undefined), delay(200)]);
      return;
    }
    await closing;
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
    queue.on("error", () => undefined);
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
      lockDuration: this.lockDurationMs,
      stalledInterval: this.stalledIntervalMs,
      maxStalledCount: 5,
    });
    worker.on("error", () => undefined);
    this.workers.set(queueName, worker);
    await worker.startStalledCheckTimer();
    return worker;
  }

  protected async persistReservedEnvelope(job: BullJob, envelope: JobEnvelope): Promise<void> {
    await job.updateData(envelope);
  }

  private takeInflight(receipt: JobReceipt): BullJob {
    const job = this.inflight.get(receipt.token);
    if (!job) {
      throw new Error(`Queue job ${receipt.jobId} is not reserved by this worker.`);
    }
    this.inflight.delete(receipt.token);
    return job;
  }

  private startRenewal(job: BullJob, token: string): void {
    const every = Math.max(50, Math.floor(this.lockDurationMs / 2));
    const timer = setInterval(() => {
      void this.renew(job, token);
    }, every);
    timer.unref();
    this.renewalTimers.set(token, timer);
  }

  private async renew(job: BullJob, token: string): Promise<void> {
    try {
      const extended = await job.extendLock(token, this.lockDurationMs);
      if (Number(extended) === 1) {
        return;
      }
    } catch {
      // The lock command failed. Treat the reservation as lost.
    }
    this.markLockLost(token);
  }

  private markLockLost(token: string): void {
    const notify = this.lockListeners.get(token);
    this.inflight.delete(token);
    this.lostTokens.add(token);
    this.stopRenewal(token);
    if (notify) {
      this.lostTokens.delete(token);
      notify();
    }
  }

  private stopRenewal(token: string): void {
    const timer = this.renewalTimers.get(token);
    if (timer) {
      clearInterval(timer);
    }
    this.renewalTimers.delete(token);
    this.lockListeners.delete(token);
  }

  private async settleUnrecoverable(queueName: string, job: BullJob, token: string): Promise<void> {
    this.inflight.delete(token);
    this.stopRenewal(token);
    const reason = "Job envelope does not match the shared JSON Schema.";
    await job.moveToFailed(new UnrecoverableError(reason), token, false);
    await this.deadLetter(queueName, job);
  }

  private async dropLock(receipt: JobReceipt): Promise<void> {
    try {
      await this.connection.del(`${PREFIX}:${receipt.queueName}:${receipt.jobId}:lock`);
    } catch {
      // Renewal is already stopped, so the lock expires and stall recovery can run.
    }
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isDuplicateJob(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message.includes("Job") && message.toLowerCase().includes("exist");
}

function cancelKey(jobId: string): string {
  return `editagent:job-cancel:${jobId}`;
}

/**
 * Queue port. Callers see job ids, envelopes, and receipts.
 * Redis, BullMQ, and lock tokens stay inside the adapter as strings.
 */

import { type JobId } from "../../kernel/id.js";
import { type JobSubject } from "./job.js";

export interface JobEnvelope {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly queueName: string;
  readonly jobType: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly attempt: number;
  readonly backoffBaseMs: number;
  readonly subject: {
    readonly kind: "project" | "media-asset" | "derived-asset";
    readonly id: string;
  };
}

export interface EnqueueJobCommand {
  readonly id: JobId;
  readonly queueName: string;
  readonly jobType: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly subject: JobSubject;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
}

export interface EnqueueJobResult {
  readonly jobId: string;
  readonly duplicate: boolean;
}

/** Opaque handle for the reserved queue message. The adapter owns its meaning. */
export interface JobReceipt {
  readonly jobId: string;
  readonly queueName: string;
  readonly token: string;
}

export interface ReservedJob {
  readonly receipt: JobReceipt;
  readonly envelope: JobEnvelope;
}

export interface JobFailure {
  readonly reason: string;
  readonly transient: boolean;
}

export interface JobProgressEvent {
  readonly message: string;
}

export interface JobQueue {
  enqueue(command: EnqueueJobCommand): Promise<EnqueueJobResult>;
  reserve(queueName: string): Promise<ReservedJob | null>;
  complete(receipt: JobReceipt): Promise<void>;
  fail(receipt: JobReceipt, failure: JobFailure): Promise<void>;
  /** Return a reserved job to the queue, or drop its lock so recovery can take it. */
  release(receipt: JobReceipt): Promise<void>;
  requestCancel(jobId: string): Promise<void>;
  isCancelRequested(jobId: string): Promise<boolean>;
  /** Fires if this process loses the reservation before complete or fail. */
  whenLockLost(receipt: JobReceipt, notify: () => void): void;
  discardQueued(jobId: string, queueName: string): Promise<void>;
  publishProgress(jobId: string, event: JobProgressEvent): Promise<void>;
  close(): Promise<void>;
}

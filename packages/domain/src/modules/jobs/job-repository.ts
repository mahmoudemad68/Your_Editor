import { type JobId } from "../../kernel/id.js";
import { type JobAttempt } from "./job-attempt.js";
import { type Job } from "./job.js";

export interface JobDeadLetter {
  readonly jobId: JobId;
  readonly reason: string;
  readonly envelopeJson: string;
  readonly createdAt: bigint;
}

/** Persistence port. This interface has no BullMQ, Redis, or ORM types. */
export interface JobRepository {
  findById(id: JobId): Promise<Job | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<Job | null>;
  save(job: Job): Promise<void>;
  appendAttempt(attempt: JobAttempt): Promise<void>;
  /**
   * Commits a Completed job and its closed Completed attempt together.
   * Either both rows persist or neither does.
   */
  recordCompletion(job: Job, attempt: JobAttempt): Promise<void>;
  listAttempts(id: JobId): Promise<readonly JobAttempt[]>;
  saveDeadLetter(letter: JobDeadLetter): Promise<void>;
  findDeadLetter(id: JobId): Promise<JobDeadLetter | null>;
}

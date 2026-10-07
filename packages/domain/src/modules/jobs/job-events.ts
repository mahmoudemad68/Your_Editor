import { type JobStatus } from "./job.js";

export const JOB_PROGRESS_STAGES = [
  "staging",
  "validating",
  "probing",
  "decoding",
  "proxy",
  "asr",
  "mix",
  "poster",
  "sprite",
  "uploading",
  "finalizing",
] as const;
export type JobProgressStage = (typeof JOB_PROGRESS_STAGES)[number];
export interface JobProgressEvent {
  readonly percentage: number;
  readonly stage: JobProgressStage;
  readonly attempt: number;
}
export function assertJobProgress(event: JobProgressEvent): void {
  if (
    !Number.isFinite(event.percentage) ||
    event.percentage < 0 ||
    event.percentage > 100 ||
    !Number.isSafeInteger(event.attempt) ||
    event.attempt < 1 ||
    !JOB_PROGRESS_STAGES.includes(event.stage)
  ) {
    throw new Error("Invalid job progress.");
  }
}
interface JobEventBase {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly jobId: string;
  readonly jobType: string;
  readonly projectId: string;
  readonly sequence: number;
  readonly attempt: number;
  readonly occurredAt: string;
  readonly correlationId?: string;
}
export type JobEvent = JobEventBase &
  (
    | { readonly kind: "progress"; readonly percentage: number; readonly stage: JobProgressStage }
    | {
        readonly kind: "state";
        readonly status: JobStatus;
        readonly reason?: "processing_failed" | "cancelled";
      }
  );
/** Implementations resolve identity and ownership from persisted jobs, never producer payloads. */
export interface JobEventPublisher {
  progress(jobId: string, event: JobProgressEvent): Promise<void>;
  state(jobId: string): Promise<void>;
  flush(jobId: string): Promise<void>;
  close(): Promise<void>;
}
export interface JobEventSubscription {
  close(): Promise<void>;
}
export interface JobEventSubscriber {
  subscribe(projectId: string, receive: (event: JobEvent) => void): Promise<JobEventSubscription>;
  close(): Promise<void>;
}

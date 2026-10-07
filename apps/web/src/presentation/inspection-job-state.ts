import type { JobEvent, JobProgressStage } from "@editagent/schemas";
import type { InspectionJob, JobEventStream, JobStatusApi } from "../job-contract";
export interface JobView {
  job: InspectionJob | null;
  progress: { stage: JobProgressStage; percentage: number } | null;
  loading: boolean;
  retrying: boolean;
  error: string | null;
}
/** Media association comes only from snapshots/retry responses, never event payloads. */
export class InspectionJobState {
  private state: JobView = {
    job: null,
    progress: null,
    loading: true,
    retrying: false,
    error: null,
  };
  private abort = new AbortController();
  private readonly listeners = new Set<() => void>();
  private readonly buffered = new Map<string, JobEvent[]>();
  private readonly terminal = new Set<string>();
  private readonly retired = new Set<string>();
  private stopStream?: () => void;
  private request = 0;
  private revision = 0;
  private discovery?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly project: string,
    private readonly media: string,
    private readonly api: JobStatusApi,
    private readonly stream: JobEventStream,
    private readonly onTerminal: () => void,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(update: Partial<JobView>) {
    if (this.abort.signal.aborted) return;
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }
  start() {
    if (this.abort.signal.aborted) this.abort = new AbortController();
    this.stopStream = this.stream.subscribe(this.project, {
      event: (e) => this.event(e),
      reconcile: () => {
        void this.reconcile();
      },
    });
    void this.reconcile();
  }
  stop() {
    ++this.request;
    this.abort.abort();
    this.stopStream?.();
    clearTimeout(this.discovery);
    this.discovery = undefined;
    this.buffered.clear();
  }
  async reconcile() {
    const request = ++this.request,
      revision = this.revision;
    try {
      const job = await this.api.snapshot(this.project, this.media, this.abort.signal);
      if (request !== this.request || this.abort.signal.aborted) return;
      // A snapshot started before an event/retry cannot regress that Job.
      if (revision !== this.revision && (!job || job.jobId === this.state.job?.jobId)) {
        this.publish({ loading: false });
        return;
      }
      this.acceptSnapshot(job);
      this.publish({ loading: false, error: null });
    } catch {
      if (request === this.request)
        this.publish({
          loading: false,
          error: "Job status could not be refreshed. Reconnecting will reconcile it.",
        });
    }
  }
  private acceptSnapshot(job: InspectionJob | null, successor = false) {
    if (job && this.retired.has(job.jobId)) return;
    const current = this.state.job;
    if (!job && current) return;
    if (job && current && !successor) {
      if (
        job.jobId !== current.jobId &&
        (BigInt(job.createdAt) < BigInt(current.createdAt) ||
          (job.createdAt === current.createdAt && job.jobId < current.jobId))
      )
        return;
      if (
        job.jobId === current.jobId &&
        (job.sequence < current.sequence || BigInt(job.updatedAt) < BigInt(current.updatedAt))
      )
        return;
    }
    if (job && current && job.jobId !== current.jobId) {
      this.retired.add(current.jobId);
      if (this.retired.size > 64) this.retired.delete(this.retired.values().next().value!);
    }
    const sameAttempt = job?.jobId === current?.jobId && job?.attempt === current?.attempt;
    this.publish({
      job,
      progress: sameAttempt && job?.status === "Running" ? this.state.progress : null,
    });
    if (job) {
      const events = this.buffered.get(job.jobId) ?? [];
      this.buffered.delete(job.jobId);
      for (const event of events.sort((a, b) => a.sequence - b.sequence)) this.apply(event);
      this.checkTerminal();
    }
  }
  private event(event: JobEvent) {
    if (
      event.projectId !== this.project ||
      event.jobType !== "media.inspect" ||
      this.retired.has(event.jobId) ||
      this.abort.signal.aborted
    )
      return;
    if (event.jobId === this.state.job?.jobId) {
      this.apply(event);
      return;
    }
    // Buffer the latest state/progress pair for an event racing initial identity or retry.
    const previous = this.buffered.get(event.jobId) ?? [];
    if (previous.some((e) => e.kind === event.kind && e.sequence >= event.sequence)) return;
    this.buffered.set(event.jobId, [...previous.filter((e) => e.kind !== event.kind), event]);
    if (this.buffered.size > 64) this.buffered.delete(this.buffered.keys().next().value!);
    if (
      (!this.state.job || (event.kind === "state" && event.status === "Queued")) &&
      !this.discovery &&
      !this.state.retrying
    )
      this.discovery = setTimeout(() => {
        this.discovery = undefined;
        void this.reconcile();
      }, 200);
  }
  private apply(event: JobEvent) {
    const job = this.state.job;
    if (!job || event.jobId !== job.jobId || event.sequence <= job.sequence) return;
    if (event.sequence > job.sequence + 1 && !this.discovery)
      this.discovery = setTimeout(() => {
        this.discovery = undefined;
        void this.reconcile();
      }, 200);
    this.revision++;
    if (event.kind === "progress")
      this.publish({
        job: { ...job, sequence: event.sequence, attempt: event.attempt, status: "Running" },
        progress: { stage: event.stage, percentage: event.percentage },
      });
    else
      this.publish({
        job: {
          ...job,
          sequence: event.sequence,
          status: event.status,
          attempt: event.attempt,
          reason: event.reason ?? null,
        },
        progress:
          event.status === "Running" && job.attempt === event.attempt ? this.state.progress : null,
      });
    this.checkTerminal();
  }
  private checkTerminal() {
    const job = this.state.job;
    if (!job || !["Completed", "Failed", "Cancelled"].includes(job.status)) return;
    const key = `${job.jobId}:${job.status}`;
    if (this.terminal.has(key)) return;
    this.terminal.add(key);
    // Bound history retained by this visible media controller.
    if (this.terminal.size > 64) this.terminal.delete(this.terminal.values().next().value!);
    this.onTerminal();
  }
  async retry() {
    if (
      this.state.retrying ||
      !this.state.job ||
      !["Failed", "Cancelled"].includes(this.state.job.status)
    )
      return;
    this.publish({ retrying: true, error: null });
    ++this.request; // invalidate older snapshots
    try {
      const job = await this.api.retry(this.project, this.media, this.abort.signal);
      if (this.abort.signal.aborted) return;
      ++this.request;
      this.revision++;
      this.acceptSnapshot(job, true);
    } catch {
      this.publish({ error: "Retry could not be queued. Please try again." });
    } finally {
      this.publish({ retrying: false });
    }
  }
}

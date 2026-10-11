import { compositionTiming } from "../application/timeline-mapping.js";
import { createServiceLogger } from "@editagent/shared";
import type { JobEnvelope } from "@editagent/domain";
import {
  PermanentJobError,
  JobExecutionUnconfirmedError,
  type JobSupervisor,
  type IsolatedHandler,
} from "@editagent/job-queue";
import type { IRenderStrategy, RenderArtifact } from "../application/ports.js";
import { parseRenderInput, progressPercentage } from "./contract.js";
export class RenderJobSupervisor implements JobSupervisor {
  constructor(
    private strategy: IRenderStrategy,
    private onProgress: (id: string, percentage: number, attempt: number) => Promise<void>,
    private shutdown?: AbortSignal,
  ) {}
  async run(envelope: JobEnvelope, _handler: IsolatedHandler, signal: AbortSignal): Promise<void> {
    if (envelope.jobType !== "render.remotion" || envelope.subject.kind !== "project")
      throw new PermanentJobError("Invalid render job subject.");
    const input = parseRenderInput(envelope.payload);
    const logger = createServiceLogger("render-worker"),
      started = Date.now();
    const context = {
      jobId: envelope.jobId,
      jobType: envelope.jobType,
      subjectId: envelope.subject.id,
      correlationId: input.correlationId,
      renderVersion: input.renderVersion,
      compositionId: input.compositionId,
      attempt: envelope.attempt,
      totalFrames: compositionTiming(input).durationInFrames,
    };
    logger.info({ ...context, phase: "rendering" }, "render.started");
    const abort = new AbortController();
    const stop = () => abort.abort(signal.reason ?? new Error("Render service shutdown."));
    signal.addEventListener("abort", stop, { once: true });
    this.shutdown?.addEventListener("abort", stop, { once: true });
    if (signal.aborted || this.shutdown?.aborted) stop();
    let value = 0;
    let chain = Promise.resolve();
    let artifact: RenderArtifact | undefined;
    try {
      await this.onProgress(envelope.jobId, 0, envelope.attempt);
      artifact = await this.strategy.render(
        input,
        envelope.subject.id,
        envelope.jobId,
        abort.signal,
        (p) => {
          const next = progressPercentage(p, value);
          if (next === value) return;
          value = next;
          chain = chain
            .then(() => this.onProgress(envelope.jobId, next, envelope.attempt))
            .catch(() => undefined);
        },
      );
      await chain;
      abort.signal.throwIfAborted();
      await this.onProgress(envelope.jobId, 100, envelope.attempt);
      abort.signal.throwIfAborted();
      logger.info(
        {
          ...context,
          phase: "validated_uploaded",
          wallTimeMs: Date.now() - started,
          outputKey: artifact.objectKey,
          outputSha256: artifact.sha256,
        },
        "render.finished",
      );
    } catch (error) {
      if (artifact && abort.signal.aborted) {
        try {
          await this.strategy.discard(artifact);
        } catch {
          throw new JobExecutionUnconfirmedError();
        }
      }
      logger.error(
        {
          ...context,
          phase: "failed",
          errorCode: abort.signal.aborted ? "render_aborted" : "render_failed",
        },
        "render.failed",
      );
      throw error;
    } finally {
      signal.removeEventListener("abort", stop);
      this.shutdown?.removeEventListener("abort", stop);
    }
  }
}

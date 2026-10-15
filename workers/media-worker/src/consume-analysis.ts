import { randomBytes } from "node:crypto";
import path from "node:path";
import { PostgresAnalysis, analysisConfiguration } from "@editagent/analysis-core";
import { createUuidV7, instant, type JobQueue } from "@editagent/domain";
import { runNextJob, PostgresJobRepository } from "@editagent/job-queue";
import { type Pool } from "pg";
import { ChildProcessJobSupervisor } from "./infrastructure/child-job-supervisor.js";

export async function consumeAnalysis(
  pool: Pool,
  queue: JobQueue,
  mediaQueue: string,
  signal: AbortSignal,
): Promise<void> {
  const store = new PostgresAnalysis(pool);
  const configuration = analysisConfiguration();
  const deps = {
    jobs: new PostgresJobRepository(pool),
    queue,
    supervisor: {
      run: (
        envelope: Parameters<ChildProcessJobSupervisor["run"]>[0],
        handler: Parameters<ChildProcessJobSupervisor["run"]>[1],
        jobSignal: AbortSignal,
      ) =>
        new ChildProcessJobSupervisor().run(
          envelope,
          handler,
          AbortSignal.any([signal, jobSignal]),
        ),
    },
    now: () => instant(BigInt(Date.now())),
    newAttemptId: () => createUuidV7(Date.now(), randomBytes(10)),
  };
  while (!signal.aborted) {
    try {
      await store.scheduleDerivations(queue, mediaQueue);
      await store.discover(configuration);
      await store.recover(queue);
      await runNextJob(deps, "media-analysis-v1-audio", {
        modulePath: path.join(__dirname, "handlers/analysis-audio.js"),
        exportName: "handleAudioAnalysis",
      });
    } catch {
      /* Fixed retry; durable intents/results remain recoverable. */
    }
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const end = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", end);
        resolve();
      };
      const timer = setTimeout(end, 250);
      signal.addEventListener("abort", end, { once: true });
    });
  }
}

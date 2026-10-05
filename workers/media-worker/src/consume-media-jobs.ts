import { randomBytes } from "node:crypto";
import path from "node:path";
import { createUuidV7, instant, type JobQueue } from "@editagent/domain";
import { mediaInspectQueueName, runNextJob, type JobLifecycleEvent } from "@editagent/job-queue";
import { type JsonLogger, logWithCorrelation } from "@editagent/shared";
import { type Pool } from "pg";

import { ChildProcessJobSupervisor } from "./infrastructure/child-job-supervisor.js";
import { PostgresJobRepository } from "./infrastructure/postgres-job-repository.js";

export function logJobLifecycle(logger: JsonLogger, event: JobLifecycleEvent): void {
  if (event.correlationId === null) {
    return;
  }
  logWithCorrelation(logger, event.correlationId, event.message, {
    jobId: event.jobId,
    jobType: event.jobType,
    subjectId: event.subjectId,
  });
}

/** Reserves BullMQ jobs and runs them until the process is stopped. */
export async function consumeMediaJobs(
  pool: Pool,
  queue: JobQueue,
  logger: JsonLogger,
  queueName: string,
): Promise<void> {
  const jobs = new PostgresJobRepository(pool);
  const supervisor = new ChildProcessJobSupervisor();
  const handler = {
    modulePath: path.join(__dirname, "handlers/media-jobs.js"),
    exportName: "handleMediaJob",
  };
  for (;;) {
    try {
      const outcome = await runNextJob(
        {
          jobs,
          queue,
          supervisor,
          now: () => instant(BigInt(Date.now())),
          newAttemptId: () => createUuidV7(Date.now(), randomBytes(10)),
          onLifecycle: (event) => {
            logJobLifecycle(logger, event);
          },
        },
        mediaInspectQueueName(queueName),
        handler,
      );
      if (outcome === "idle") {
        await delay(200);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`media-worker job loop: ${message}\n`);
      await delay(500);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

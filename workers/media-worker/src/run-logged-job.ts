/**
 * Logs one job payload. US-129 owns queue delivery. This entry proves the
 * correlation id inside that payload reaches every worker log line.
 */

import {
  createServiceLogger,
  logWithCorrelation,
  parseLoggedJob,
  startNoopTracing,
} from "@editagent/shared";

export function runLoggedJob(raw: string): void {
  const job = parseLoggedJob(raw);
  startNoopTracing("media-worker");
  const logger = createServiceLogger("media-worker");
  logWithCorrelation(logger, job.correlationId, "job.started", {
    jobType: job.jobType,
    subjectId: job.subjectId,
  });
  logWithCorrelation(logger, job.correlationId, "job.finished", {
    jobType: job.jobType,
    subjectId: job.subjectId,
  });
}

if (require.main === module) {
  const raw = process.argv[2];
  if (raw === undefined || process.argv.length !== 3) {
    process.stderr.write("usage: node dist/run-logged-job.js <job-json>\n");
    process.exitCode = 1;
  } else {
    try {
      runLoggedJob(raw);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
  }
}

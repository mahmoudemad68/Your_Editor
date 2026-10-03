import { createLoggedJob, type JsonLogger, logWithCorrelation } from "@editagent/shared";

import { requestCorrelationId } from "./correlation.js";

/** Writes the job payload the worker will log. It does not run the worker. */
export class ApiRequestLog {
  constructor(private readonly logger: JsonLogger) {}

  jobAccepted(jobType: string, subjectId: string): void {
    const correlationId = requestCorrelationId();
    const job = createLoggedJob({ correlationId, jobType, subjectId });
    logWithCorrelation(this.logger, job.correlationId, "job.accepted", {
      jobType: job.jobType,
      subjectId: job.subjectId,
    });
  }
}

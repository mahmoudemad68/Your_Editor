import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** Header the web app sends and the API echoes. */
export const CORRELATION_HEADER = "x-request-id";

const CORRELATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const correlationStore = new AsyncLocalStorage<string>();

/** Accept a caller-supplied id. Reject blanks and characters that could break a log line. */
export function acceptCorrelationId(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  return CORRELATION_PATTERN.test(value) ? value : null;
}

export function createCorrelationId(): string {
  return `req_${randomUUID().replace(/-/g, "")}`;
}

export function bindCorrelationId(correlationId: string): void {
  correlationStore.enterWith(correlationId);
}

export function currentCorrelationId(): string | undefined {
  return correlationStore.getStore();
}

/** Work handed from an HTTP request to a worker. The correlation id travels inside the payload. */
export interface LoggedJob {
  readonly correlationId: string;
  readonly jobType: string;
  readonly subjectId: string;
}

export function createLoggedJob(input: {
  readonly correlationId: string;
  readonly jobType: string;
  readonly subjectId: string;
}): LoggedJob {
  const correlationId = acceptCorrelationId(input.correlationId);
  const jobType = input.jobType.trim();
  const subjectId = input.subjectId.trim();
  if (correlationId === null || jobType.length === 0 || subjectId.length === 0) {
    throw new Error("A job payload requires a correlation ID, job type, and subject.");
  }
  return { correlationId, jobType, subjectId };
}

export function parseLoggedJob(raw: string): LoggedJob {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Job payload must be a JSON object.");
  }
  const record = parsed as Record<string, unknown>;
  return createLoggedJob({
    correlationId: typeof record.correlationId === "string" ? record.correlationId : "",
    jobType: typeof record.jobType === "string" ? record.jobType : "",
    subjectId: typeof record.subjectId === "string" ? record.subjectId : "",
  });
}

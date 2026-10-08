import { Writable } from "node:stream";
import pino, { type Logger } from "pino";

import { acceptCorrelationId } from "./correlation.js";

export type JsonLogger = Logger;

// Application logs contain operational metadata, never arbitrary request/error
// objects. Extend this list deliberately when adding an operational field.
const LOG_FIELDS = new Set([
  "service",
  "correlationId",
  "traceId",
  "jobId",
  "jobType",
  "subjectId",
  "eventKind",
  "method",
  "path",
  "status",
  "attempt",
  "stage",
  "percentage",
  "errorCode",
  "component",
  "duplicate",
  "abortedStreams",
  "activeStreams",
]);

export function createServiceLogger(service: string, stream?: Writable): JsonLogger {
  return pino(
    {
      level: "info",
      base: { service },
      messageKey: "message",
      formatters: {
        log(fields) {
          return Object.fromEntries(
            Object.entries(fields).filter(
              ([key, value]) =>
                LOG_FIELDS.has(key) && ["string", "number", "boolean"].includes(typeof value),
            ),
          );
        },
        level(label) {
          return { level: label };
        },
      },
    },
    stream ?? process.stdout,
  );
}

/** Every application log line carries the correlation id. The id is not optional. */
export function logWithCorrelation(
  logger: JsonLogger,
  correlationId: string,
  message: string,
  fields: Readonly<Record<string, string>> = {},
): void {
  const accepted = acceptCorrelationId(correlationId);
  if (accepted === null) {
    throw new Error("A log line requires a correlation ID.");
  }
  logger.info({ ...fields, correlationId: accepted }, message);
}

import { Writable } from "node:stream";
import pino, { type Logger } from "pino";

import { acceptCorrelationId } from "./correlation.js";

export type JsonLogger = Logger;

export function createServiceLogger(service: string, stream?: Writable): JsonLogger {
  return pino(
    {
      level: "info",
      base: { service },
      messageKey: "message",
      formatters: {
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

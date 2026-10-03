import {
  acceptCorrelationId,
  bindCorrelationId,
  CORRELATION_HEADER,
  createCorrelationId,
  currentCorrelationId,
  type JsonLogger,
  logWithCorrelation,
} from "@editagent/shared";

interface HeaderRequest {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  url?: string;
  originalUrl?: string;
}

interface HeaderResponse {
  setHeader(name: string, value: string): void;
}

/** Binds the web app's request id, or a generated one, for the rest of this request. */
export function bindRequestCorrelation(
  logger: JsonLogger,
): (request: HeaderRequest, response: HeaderResponse, next: () => void) => void {
  return (request, response, next) => {
    const raw = request.headers[CORRELATION_HEADER];
    const incoming = Array.isArray(raw) ? raw[0] : raw;
    const correlationId = acceptCorrelationId(incoming) ?? createCorrelationId();
    response.setHeader(CORRELATION_HEADER, correlationId);
    bindCorrelationId(correlationId);
    logWithCorrelation(logger, correlationId, "request.received", {
      method: request.method ?? "GET",
      path: request.originalUrl ?? request.url ?? "/",
    });
    next();
  };
}

export function requestCorrelationId(): string {
  return currentCorrelationId() ?? createCorrelationId();
}

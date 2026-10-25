import { InspectionRetryConflict } from "../application/inspection-job.js";
import { AgentError } from "@editagent/agent-core";
import { TimelineConflict } from "../application/timeline-editor.js";
import { RenderUnavailable } from "../application/timeline-exports.js";
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from "@nestjs/common";
import { DomainError, MediaAssetConflict, ProjectConflict } from "@editagent/domain";
import { createCorrelationId, currentCorrelationId, type JsonLogger } from "@editagent/shared";
import { ProjectForbiddenError, ProjectNotFoundError } from "../application/project-access.js";
import {
  ObjectStorageUnavailable,
  UploadObjectMismatch,
  UploadObjectMissing,
  UploadPolicyError,
} from "../application/upload-errors.js";

interface HttpReply {
  status(code: number): {
    json(body: unknown): void;
    type?(value: string): void;
  };
}

/** Maps application and domain failures to HTTP. It does not decide membership. */
@Catch()
export class ProjectExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: JsonLogger) {}

  private logFailure(status: number, errorCode: string): string {
    const traceId = currentCorrelationId() ?? createCorrelationId();
    this.logger.error({ correlationId: traceId, traceId, status, errorCode }, "request.failed");
    return traceId;
  }
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpReply>();
    if (exception instanceof AgentError) {
      const code = exception.code;
      const status =
        code === "not_found"
          ? 404
          : code === "forbidden"
            ? 403
            : code === "invalid_input"
              ? 400
              : 409;
      response.status(status).json({
        statusCode: status,
        message:
          code === "not_found"
            ? "Project not found."
            : code === "forbidden"
              ? "This operation requires editing access."
              : code === "invalid_input"
                ? "Invalid AgentRun request."
                : "AgentRun state conflict.",
      });
      return;
    }
    if (exception instanceof RenderUnavailable) {
      response.status(503).json({ statusCode: 503, message: exception.message });
      return;
    }
    // /ready has an established, deliberately small 503 response contract.
    if (exception instanceof HttpException && exception.getStatus() === 503) {
      const body = exception.getResponse();
      if (
        typeof body === "object" &&
        body !== null &&
        Object.keys(body).length === 1 &&
        "status" in body &&
        body.status === "not-ready"
      ) {
        response.status(503).json(body);
        return;
      }
    }
    if (exception instanceof HttpException && exception.getStatus() < 500) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    if (exception instanceof ProjectNotFoundError) {
      response.status(404).json({ statusCode: 404, message: exception.message });
      return;
    }
    if (exception instanceof ProjectForbiddenError) {
      response.status(403).json({ statusCode: 403, message: exception.message });
      return;
    }
    if (
      exception instanceof InspectionRetryConflict ||
      exception instanceof TimelineConflict ||
      exception instanceof ProjectConflict ||
      exception instanceof MediaAssetConflict
    ) {
      response.status(409).json({ statusCode: 409, message: exception.message });
      return;
    }
    if (exception instanceof UploadPolicyError) {
      response.status(400).json({ statusCode: 400, message: exception.message });
      return;
    }
    if (exception instanceof UploadObjectMissing || exception instanceof UploadObjectMismatch) {
      response.status(409).json({ statusCode: 409, message: exception.message });
      return;
    }
    if (exception instanceof ObjectStorageUnavailable) {
      this.logFailure(502, "object_storage_unavailable");
      response.status(502).json({ statusCode: 502, message: exception.message });
      return;
    }
    if (exception instanceof DomainError) {
      response.status(400).json({ statusCode: 400, message: exception.message });
      return;
    }
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const traceId = this.logFailure(
      status,
      exception instanceof HttpException ? "http_server_error" : "unexpected_server_error",
    );
    const sent = response.status(status);
    sent.type?.("application/problem+json");
    sent.json({
      type: "about:blank",
      title: status === 503 ? "Service Unavailable" : "Internal Server Error",
      status,
      detail: "An unexpected error occurred.",
      traceId,
    });
  }
}

import { InspectionRetryConflict } from "../application/inspection-job.js";
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from "@nestjs/common";
import { DomainError, MediaAssetConflict, ProjectConflict } from "@editagent/domain";
import { createCorrelationId, currentCorrelationId } from "@editagent/shared";
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
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpReply>();
    if (exception instanceof HttpException) {
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
      response.status(502).json({ statusCode: 502, message: exception.message });
      return;
    }
    if (exception instanceof DomainError) {
      response.status(400).json({ statusCode: 400, message: exception.message });
      return;
    }
    const sent = response.status(500);
    sent.type?.("application/problem+json");
    sent.json({
      type: "about:blank",
      title: "Internal Server Error",
      status: 500,
      detail: "An unexpected error occurred.",
      traceId: currentCorrelationId() ?? createCorrelationId(),
    });
  }
}

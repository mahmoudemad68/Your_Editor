import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from "@nestjs/common";
import { DomainError, ProjectConflict } from "@editagent/domain";
import { ProjectForbiddenError, ProjectNotFoundError } from "../application/project-access.js";

interface HttpReply {
  status(code: number): { json(body: unknown): void };
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
    if (exception instanceof ProjectConflict) {
      response.status(409).json({ statusCode: 409, message: exception.message });
      return;
    }
    if (exception instanceof DomainError) {
      response.status(400).json({ statusCode: 400, message: exception.message });
      return;
    }
    response.status(500).json({ statusCode: 500, message: "Internal server error." });
  }
}

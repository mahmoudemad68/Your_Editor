import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  BadRequestException,
  HttpException,
} from "@nestjs/common";
import { ApiBody, ApiProduces, ApiProperty, ApiTags, ApiResponse, ApiQuery } from "@nestjs/swagger";
import {
  agentRunOpenApiSchema,
  agentAuditPageOpenApiSchema,
  agentExportOpenApiSchema,
} from "@editagent/agent-core";
import type { ApiResponseSchemaHost } from "@nestjs/swagger";
type SchemaObject = ApiResponseSchemaHost["schema"];
import { AGENT_RUNS, type AgentRuns } from "../application/agent-runs.js";
import { requireActor, sessionStillValid } from "./actor.js";
import { requestCorrelationId } from "./correlation.js";

class StartAgentRunDto {
  @ApiProperty({ minLength: 16, maxLength: 96 }) idempotencyKey!: string;
  @ApiProperty({ required: false, format: "uuid" }) timelineId?: string;
  @ApiProperty({ required: false, pattern: "^[a-f0-9]{64}$" }) stateSha256?: string;
}
interface Request {
  headers: Record<string, string | string[] | undefined>;
}
interface StreamReply {
  setHeader(name: string, value: string): void;
  flushHeaders(): void;
  write(data: string, callback: (error?: Error | null) => void): boolean;
  end(): void;
  destroy(): void;
  socket?: { resetAndDestroy(): unknown } | null;
  once(event: string, listener: () => void): void;
  removeListener(event: string, listener: () => void): void;
}
@ApiTags("agent-runs")
@Controller("projects/:projectId/agent-runs")
export class AgentRunsController {
  private readonly streams = new Map<string, Set<() => void>>();
  private active = 0;
  onModuleDestroy(): void {
    for (const group of this.streams.values()) for (const stop of group) stop();
  }
  constructor(@Inject(AGENT_RUNS) private readonly runs: AgentRuns) {}
  @Post()
  @ApiBody({ type: StartAgentRunDto })
  @ApiResponse({ status: 201, schema: agentRunOpenApiSchema as SchemaObject })
  start(@Param("projectId") project: string, @Body() input: unknown, @Req() req: object) {
    return this.runs.start(requireActor(req), project, input, requestCorrelationId());
  }
  @Get(":runId")
  @ApiResponse({ status: 200, schema: agentRunOpenApiSchema as SchemaObject })
  get(@Param("projectId") project: string, @Param("runId") id: string, @Req() req: object) {
    return this.runs.get(requireActor(req), project, id);
  }
  @Post(":runId/cancel")
  @ApiResponse({ status: 201, schema: agentRunOpenApiSchema as SchemaObject })
  cancel(
    @Param("projectId") project: string,
    @Param("runId") id: string,
    @Req() req: object,
    @Body() body: unknown,
  ) {
    const actor = requireActor(req);
    if (
      body !== undefined &&
      body !== null &&
      (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0)
    )
      throw new BadRequestException("No cancellation payload is accepted.");
    return this.runs.cancel(actor, project, id);
  }
  @Get(":runId/audit")
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiQuery({ name: "limit", required: false, type: Number })
  @ApiResponse({
    status: 200,
    schema: agentAuditPageOpenApiSchema as SchemaObject,
  })
  audit(
    @Param("projectId") project: string,
    @Param("runId") id: string,
    @Req() req: object,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.runs.audit(requireActor(req), project, id, cursor, pageSize(limit));
  }
  @Get(":runId/export")
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiQuery({ name: "limit", required: false, type: Number })
  @ApiResponse({
    status: 200,
    schema: agentExportOpenApiSchema as SchemaObject,
    description:
      "Bounded audit page plus source hashes and versioned trim/split command receipts. See agent-runs.md.",
  })
  export(
    @Param("projectId") project: string,
    @Param("runId") id: string,
    @Req() req: object,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.runs.export(requireActor(req), project, id, cursor, pageSize(limit));
  }
  @Get(":runId/events")
  @ApiProduces("text/event-stream")
  async events(
    @Param("projectId") project: string,
    @Param("runId") id: string,
    @Req() req: Request,
    @Res() res: StreamReply,
    @Query("after") after?: string,
  ): Promise<void> {
    const actor = requireActor(req);
    if (!(await sessionStillValid(req))) throw new UnauthorizedException("Sign in is required.");
    const header = req.headers["last-event-id"];
    if (Array.isArray(header) || (header !== undefined && after !== undefined && header !== after))
      throw new BadRequestException("Invalid event cursor.");
    let cursor = header ?? after;
    let page = await this.runs.events(actor, project, id, cursor);
    if (!(await sessionStillValid(req))) throw new UnauthorizedException("Sign in is required.");
    const group = this.streams.get(actor) ?? new Set<() => void>();
    if (group.size >= 4 || this.active >= 64)
      throw new HttpException("Too many active AgentRun streams.", 429);
    const terminate = () => {
      if (res.socket?.resetAndDestroy) res.socket.resetAndDestroy();
      else res.destroy();
    };
    group.add(terminate);
    this.streams.set(actor, group);
    this.active++;
    let closed = false;
    const close = () => {
      closed = true;
    };
    res.once("close", close);
    const finish = Date.now() + 120_000;
    let count = 0;
    try {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-store");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      while (!closed && Date.now() < finish && count < 256) {
        if (!(await sessionStillValid(req))) throw new Error("expired");
        if (page.length === 0) {
          await send(res, ": heartbeat\n\n");
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        for (const event of page) {
          if (closed) break;
          if (!(await sessionStillValid(req))) throw new Error("expired");
          // Reauthorize before every write, including buffered catch-up pages.
          await this.runs.get(actor, project, id);
          cursor = `${event.sequence}.${event.id}`;
          await send(res, `id: ${cursor}\nevent: agent-step\ndata: ${JSON.stringify(event)}\n\n`);
          count++;
        }
        if (!closed) page = await this.runs.events(actor, project, id, cursor);
      }
      if (!closed) res.end();
    } catch {
      if (res.socket?.resetAndDestroy) res.socket.resetAndDestroy();
      else res.destroy();
    } finally {
      res.removeListener("close", close);
      group.delete(terminate);
      this.active--;
      if (group.size === 0) this.streams.delete(actor);
    }
  }
}
function pageSize(raw?: string): number {
  if (raw === undefined) return 50;
  if (!/^[1-9][0-9]{0,2}$/.test(raw) || Number(raw) > 100)
    throw new BadRequestException("Page size must be between 1 and 100.");
  return Number(raw);
}
/** One in-flight write, bounded by callback completion; no unbounded queue. */
function send(res: StreamReply, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error?: Error | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      res.removeListener("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onClose = () => finish(new Error("closed"));
    const timer = setTimeout(() => finish(new Error("slow_client")), 5000);
    res.once("close", onClose);
    try {
      res.write(data, finish);
    } catch {
      finish(new Error("write_failed"));
    }
  });
}

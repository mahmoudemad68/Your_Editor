import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Req,
  Res,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import {
  DomainError,
  projectId,
  type JobEvent,
  type JobEventSubscription,
} from "@editagent/domain";
import { ProjectJobEvents } from "../application/job-events.js";
import { requireActor } from "./actor.js";

interface StreamResponse {
  setHeader(name: string, value: string): void;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(): void;
  once(event: string, callback: () => void): void;
  on(event: string, callback: () => void): void;
  removeListener(event: string, callback: () => void): void;
}
export const SSE_MAX_PENDING_EVENTS = 64;
export const SSE_HEARTBEAT_MS = 15000;

@ApiTags("jobs")
@Controller("projects")
export class JobEventsController {
  constructor(private readonly events: ProjectJobEvents) {}
  @Get(":projectId/jobs/events")
  @ApiOperation({
    summary:
      "Live JobEventV1 events for a visible Project; no replay. See docs/contracts/job-events.md.",
  })
  @ApiProduces("text/event-stream")
  @ApiOkResponse({
    description: "SSE job events; id = eventId, event = job, data = JobEventV1 JSON.",
  })
  @ApiUnauthorizedResponse({ description: "Sign in is required." })
  @ApiNotFoundResponse({ description: "Project is not visible to the caller." })
  @ApiBadRequestResponse({ description: "projectId must be a UUIDv7." })
  async stream(
    @Param("projectId") raw: string,
    @Req() request: object,
    @Res() response: StreamResponse,
  ): Promise<void> {
    const actor = requireActor(request);
    let id;
    try {
      id = projectId(raw);
    } catch (error) {
      if (error instanceof DomainError)
        throw new BadRequestException("projectId must be a UUIDv7.");
      throw error;
    }
    await this.events.authorize(actor, id);
    let closed = false;
    let ready = false;
    let blocked = false;
    let pumping = false;
    const timers: { heartbeat?: ReturnType<typeof setInterval> } = {};
    let slowTimer: ReturnType<typeof setTimeout> | undefined;
    let subscription: JobEventSubscription | undefined;
    const pending: JobEvent[] = [];
    let untrack = () => undefined as void;
    const close = () => {
      if (closed) return;
      closed = true;
      pending.length = 0;
      if (timers.heartbeat) clearInterval(timers.heartbeat);
      if (slowTimer) clearTimeout(slowTimer);
      response.removeListener("drain", drain);
      response.removeListener("close", close);
      untrack();
      void subscription?.close().catch(() => undefined);
      response.end();
    };
    const write = (text: string) => {
      if (!response.write(text)) {
        blocked = true;
        slowTimer = setTimeout(close, 5000);
        slowTimer.unref();
      }
    };
    const pump = async () => {
      if (!ready || closed || blocked || pumping) return;
      pumping = true;
      try {
        while (pending.length && !closed && !blocked) {
          await this.events.authorize(actor, id);
          if (closed || blocked) break;
          const event = pending.shift()!;
          write(`id: ${event.eventId}\nevent: job\ndata: ${JSON.stringify(event)}\n\n`);
        }
      } catch {
        close();
      } finally {
        pumping = false;
      }
    };
    const drain = () => {
      blocked = false;
      if (slowTimer) clearTimeout(slowTimer);
      slowTimer = undefined;
      void pump();
    };
    response.on("close", close);
    response.on("drain", drain);
    untrack = this.events.track(close);
    try {
      subscription = await this.events.subscriber.subscribe(id, (event) => {
        if (closed || event.projectId !== id) return;
        if (event.kind === "progress") {
          const index = pending.findIndex(
            (item) => item.kind === "progress" && item.jobId === event.jobId,
          );
          if (index >= 0) pending.splice(index, 1);
        }
        if (pending.length >= SSE_MAX_PENDING_EVENTS) {
          const progressIndex = pending.findIndex((item) => item.kind === "progress");
          if (progressIndex >= 0) pending.splice(progressIndex, 1);
          else {
            close();
            return;
          }
        }
        pending.push(event);
        void pump();
      });
      if (closed) {
        await subscription.close();
        return;
      }
    } catch {
      response.removeListener("close", close);
      response.removeListener("drain", drain);
      untrack();
      throw new ServiceUnavailableException("Job events unavailable.");
    }
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-store");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();
    ready = true;
    write(": connected; live delivery only\n\n");
    void pump();
    timers.heartbeat = setInterval(() => {
      if (closed || blocked || pumping) return;
      void this.events
        .authorize(actor, id)
        .then(() => {
          if (!closed && !blocked && !pumping) write(": heartbeat\n\n");
        })
        .catch(close);
    }, SSE_HEARTBEAT_MS);
    timers.heartbeat.unref();
  }
}

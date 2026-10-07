import { validateJobEvent, type JobEvent } from "@editagent/schemas";
import type { JobEventStream } from "../job-contract";
import { SseParser } from "./sse-parser";
import { sessionClient, type SessionClient } from "./session-client";
export function parseJobEvent(data: string, project: string): JobEvent | null {
  try {
    const value = JSON.parse(data) as JobEvent;
    return validateJobEvent(value) &&
      value.projectId === project &&
      value.eventId === `${value.jobId}:${value.sequence}`
      ? value
      : null;
  } catch {
    return null;
  }
}
export const JOB_RECONNECT_BACKOFF_MS = [250, 500, 1000, 2000, 5000] as const;
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}
/** Ref-counted project connections. Many cards share one fetch and one reconnect timer. */
export class ProjectJobEventStream implements JobEventStream {
  private readonly projects = new Map<
    string,
    { abort: AbortController; listeners: Set<Parameters<JobEventStream["subscribe"]>[1]> }
  >();
  constructor(
    private readonly session: Pick<
      SessionClient,
      "authenticatedFetch" | "subscribe" | "getSnapshot"
    > = sessionClient,
  ) {}
  subscribe(project: string, listener: Parameters<JobEventStream["subscribe"]>[1]) {
    let connection = this.projects.get(project);
    if (!connection) {
      connection = { abort: new AbortController(), listeners: new Set() };
      this.projects.set(project, connection);
      // Defer until this listener is registered.
      const current = connection;
      void Promise.resolve().then(() => this.run(project, current));
    }
    connection.listeners.add(listener);
    return () => {
      connection.listeners.delete(listener);
      if (!connection.listeners.size) {
        connection.abort.abort();
        if (this.projects.get(project) === connection) this.projects.delete(project);
      }
    };
  }
  private async run(
    project: string,
    connection: {
      abort: AbortController;
      listeners: Set<Parameters<JobEventStream["subscribe"]>[1]>;
    },
  ) {
    const signal = connection.abort.signal;
    const unsubscribe = this.session.subscribe(() => {
      if (this.session.getSnapshot().status === "unauthenticated") connection.abort.abort();
    });
    let failures = 0;
    try {
      while (!signal.aborted && this.session.getSnapshot().status !== "unauthenticated") {
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          const response = await this.session.authenticatedFetch(
            `/api/projects/${encodeURIComponent(project)}/jobs/events`,
            { signal, headers: { accept: "text/event-stream" } },
          );
          if ([401, 403, 404].includes(response.status)) {
            await response.body?.cancel();
            break;
          }
          if (
            !response.ok ||
            !response.body ||
            !response.headers.get("content-type")?.startsWith("text/event-stream")
          ) {
            await response.body?.cancel();
            throw new Error("Stream unavailable.");
          }
          for (const listener of connection.listeners) listener.reconcile();
          const parser = new SseParser((frame) => {
            if (frame.event !== "job" || signal.aborted) return;
            const event = parseJobEvent(frame.data, project);
            if (!event) return;
            failures = 0;
            for (const listener of connection.listeners) listener.event(event);
          });
          reader = response.body.getReader();
          const decoder = new TextDecoder();
          while (!signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) {
              parser.feed(decoder.decode());
              parser.end();
              break;
            }
            parser.feed(decoder.decode(chunk.value, { stream: true }));
          }
        } catch {
          /* Reconcile after transport gaps; pub/sub has no replay. */
        } finally {
          await reader?.cancel().catch(() => {});
          reader?.releaseLock();
        }
        if (!signal.aborted)
          await wait(
            JOB_RECONNECT_BACKOFF_MS[Math.min(failures++, JOB_RECONNECT_BACKOFF_MS.length - 1)]!,
            signal,
          );
      }
    } finally {
      unsubscribe();
      connection.abort.abort();
    }
  }
}
export const projectJobEvents = new ProjectJobEventStream();

import { createServiceLogger } from "@editagent/shared";

export const MAX_ACTIVE_JOB_PROXY_STREAMS = 1024;
/** Only live requests are retained. Shutdown cancels them before Next waits for
 * HTTP connections, leaving framework cleanup and exit handling to Next. */
export class JobStreamRegistry {
  private readonly streams = new Set<AbortController>();
  private stopping = false;
  private installed = false;
  get count(): number {
    return this.streams.size;
  }
  register(controller: AbortController): (() => void) | null {
    if (this.stopping || this.count >= MAX_ACTIVE_JOB_PROXY_STREAMS) return null;
    this.streams.add(controller);
    return () => this.streams.delete(controller);
  }
  shutdown(): number {
    this.stopping = true;
    const active = [...this.streams];
    this.streams.clear();
    for (const controller of active) controller.abort();
    return active.length;
  }
  install(signals: Pick<NodeJS.Process, "on"> = process): void {
    if (this.installed) return;
    this.installed = true;
    const stop = () => {
      const abortedStreams = this.shutdown();
      createServiceLogger("web").info(
        { abortedStreams, activeStreams: this.count },
        "job.events.proxy.shutdown",
      );
    };
    signals.on("SIGTERM", stop);
    signals.on("SIGINT", stop);
  }
}
// Instrumentation and route bundles/reloads share one registry and signal pair.
const key = Symbol.for("editagent.web.job-stream-registry");
const shared = globalThis as typeof globalThis & { [key: symbol]: JobStreamRegistry | undefined };
export const jobStreamRegistry = (shared[key] ??= new JobStreamRegistry());

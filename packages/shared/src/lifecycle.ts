import { writeFileSync } from "node:fs";

/**
 * Marker created after a scaffold worker has loaded its configuration.
 * Docker healthchecks look for this file. Queue consumers replace the wait in US-129.
 */
export const processReadyFilePath = "/tmp/editagent.ready";

/**
 * Holds a worker process open until it receives SIGINT or SIGTERM.
 * This is process plumbing for the scaffold. It does not poll a queue or run a job.
 */
export function keepProcessAlive(readyFilePath: string = processReadyFilePath): void {
  writeFileSync(readyFilePath, "ok\n", { encoding: "utf8" });
  const timer = setInterval(() => undefined, 60_000);
  const stop = (): void => {
    clearInterval(timer);
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

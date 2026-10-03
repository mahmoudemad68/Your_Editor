import {
  keepProcessAlive,
  startHealthServer,
  startNoopTracing,
  WORKER_HEALTH_PORT,
} from "@editagent/shared";
import { describeWorker } from "./application/describe.js";
import { loadRenderWorkerConfig } from "./infrastructure/config.js";

export function main(): void {
  loadRenderWorkerConfig();
  startNoopTracing("render-worker");
  // Config has loaded and this process has no further dependency probe.
  // /health stays liveness. /ready means the process can accept work.
  startHealthServer(WORKER_HEALTH_PORT, { ready: () => true });
  process.stdout.write(`${describeWorker()}\n`);
  keepProcessAlive();
}

if (require.main === module) {
  try {
    main();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

import {
  keepProcessAlive,
  startHealthServer,
  startNoopTracing,
  WORKER_HEALTH_PORT,
} from "@editagent/shared";
import { describeWorker } from "./application/describe.js";
import { loadMediaWorkerConfig } from "./infrastructure/config.js";
import { mediaAdapterPackage } from "./infrastructure/marker.js";

export function main(): void {
  loadMediaWorkerConfig();
  startNoopTracing("media-worker");
  startHealthServer(WORKER_HEALTH_PORT);
  process.stdout.write(`${describeWorker()} (${mediaAdapterPackage})\n`);
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

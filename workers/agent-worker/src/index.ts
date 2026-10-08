import {
  keepProcessAlive,
  createServiceLogger,
  startHealthServer,
  startNoopTracing,
  WORKER_HEALTH_PORT,
} from "@editagent/shared";
import { loadAgentWorkerConfig } from "./infrastructure/config.js";
import { agentToolsPackage } from "./infrastructure/marker.js";

export function main(): void {
  loadAgentWorkerConfig();
  startNoopTracing("agent-worker");
  // Config has loaded. This scaffold does not probe Redis on /ready.
  startHealthServer(WORKER_HEALTH_PORT, { ready: () => true });
  createServiceLogger("agent-worker").info({ component: agentToolsPackage }, "service.started");
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

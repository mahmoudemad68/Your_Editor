import { keepProcessAlive } from "@editagent/shared";
import { describeWorker } from "./application/describe.js";
import { loadAgentWorkerConfig } from "./infrastructure/config.js";
import { agentToolsPackage } from "./infrastructure/marker.js";

export function main(): void {
  loadAgentWorkerConfig();
  process.stdout.write(`${describeWorker()} (${agentToolsPackage})\n`);
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

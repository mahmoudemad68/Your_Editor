import { keepProcessAlive } from "@editagent/shared";
import { describeWorker } from "./application/describe.js";
import { loadRenderWorkerConfig } from "./infrastructure/config.js";

export function main(): void {
  loadRenderWorkerConfig();
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

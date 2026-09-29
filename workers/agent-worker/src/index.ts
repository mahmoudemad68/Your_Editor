import { describeWorker } from "./application/describe.js";
import { agentToolsPackage } from "./infrastructure/marker.js";

export function main(): void {
  process.stdout.write(`${describeWorker()} (${agentToolsPackage})\n`);
}

if (require.main === module) {
  main();
}

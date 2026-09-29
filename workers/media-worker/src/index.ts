import { describeWorker } from "./application/describe.js";
import { mediaAdapterPackage } from "./infrastructure/marker.js";

export function main(): void {
  process.stdout.write(`${describeWorker()} (${mediaAdapterPackage})\n`);
}

if (require.main === module) {
  main();
}

import { describeWorker } from "./application/describe.js";

export function main(): void {
  process.stdout.write(`${describeWorker()}\n`);
}

if (require.main === module) {
  main();
}

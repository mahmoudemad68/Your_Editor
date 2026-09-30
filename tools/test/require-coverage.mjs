import { statSync } from "node:fs";
import process from "node:process";

const reports = [
  "coverage/lcov.info",
  "apps/api/coverage/lcov.info",
  "apps/web/coverage/lcov.info",
  "packages/domain/coverage/lcov.info",
  "packages/media-core/coverage/lcov.info",
  "packages/schemas/coverage/lcov.info",
  "packages/shared/coverage/lcov.info",
  "packages/tool-sdk/coverage/lcov.info",
  "workers/agent-worker/coverage/lcov.info",
  "workers/media-worker/coverage/lcov.info",
  "workers/render-worker/coverage/lcov.info",
  "workers/ai-worker/coverage.xml",
];

let missing = 0;
for (const report of reports) {
  try {
    const size = statSync(report).size;
    if (size === 0) {
      process.stderr.write(`empty coverage report: ${report}\n`);
      missing += 1;
      continue;
    }
    process.stdout.write(`coverage report: ${report} (${size} bytes)\n`);
  } catch {
    process.stderr.write(`missing coverage report: ${report}\n`);
    missing += 1;
  }
}

process.exit(missing === 0 ? 0 : 1);

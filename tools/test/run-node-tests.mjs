import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import process from "node:process";

const testFiles = process.argv.slice(2);
if (testFiles.length === 0) {
  process.stderr.write("usage: run-node-tests.mjs <test-file>...\n");
  process.exit(1);
}

mkdirSync("coverage", { recursive: true });

// Reports only. Percentage gates belong to US-116, not this baseline.
const args = [
  "--test",
  "--experimental-test-coverage",
  "--test-coverage-exclude=**/node_modules/**",
  "--test-coverage-exclude=**/.venv/**",
  "--test-reporter=spec",
  "--test-reporter=lcov",
  "--test-reporter-destination=stdout",
  "--test-reporter-destination=coverage/lcov.info",
  ...testFiles,
];

const result = spawnSync(process.execPath, args, { stdio: "inherit" });
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);

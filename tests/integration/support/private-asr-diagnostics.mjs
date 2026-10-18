/** Raw inference diagnostics stay local, never in public node:test failures. */
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { test } from "node:test";

const defaultDirectory = new URL("../../../.local/asr-batch/", import.meta.url);

export async function privateAsrDiagnostic(label, value, directory = defaultDirectory) {
  if (!/^[a-z0-9-]+$/u.test(label)) throw new Error("Invalid diagnostic label.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = new URL(`${label}-${randomUUID()}.txt`, directory);
  await writeFile(file, inspect(value, { depth: 12, maxArrayLength: 1000 }), {
    mode: 0o600,
    flag: "wx",
  });
}

export async function privateAsrTest(run, directory = defaultDirectory) {
  try {
    return await run();
  } catch (error) {
    // Do not attach the original exception as a public cause or stringify it
    // into a reporter. Retain the genuine failure and its operands locally.
    await privateAsrDiagnostic("integration-failure", error, directory).catch(() => undefined);
  }
  // Cross the public reporting boundary only after the private error is saved.
  throw new Error("Real analysis integration failed; raw diagnostics remain local.");
}

export function privateAsrIntegrationTest(name, options, run) {
  return test(name, options, (...args) => privateAsrTest(() => run(...args)));
}

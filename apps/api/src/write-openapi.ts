import { writeFile } from "node:fs/promises";
import path from "node:path";
import { InMemoryProjectRepository } from "./application/in-memory-project-repository.js";
import { createOpenApiDocument } from "./create-api-application.js";
import { NodeProjectIdGenerator } from "./infrastructure/node-project-id-generator.js";
import { SystemClock } from "./infrastructure/system-clock.js";

async function main(): Promise<void> {
  const document = await createOpenApiDocument({
    projects: new InMemoryProjectRepository(),
    clock: new SystemClock(),
    ids: new NodeProjectIdGenerator(),
  });
  const target = path.resolve(__dirname, "openapi.json");
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

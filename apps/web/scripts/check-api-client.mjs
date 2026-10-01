import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(webRoot, "src/generated/schema.ts");
const clientPath = path.join(webRoot, "src/generated/client.ts");
const beforeSchema = readFileSync(schemaPath, "utf8");
const beforeClient = readFileSync(clientPath, "utf8");

const generated = spawnSync(
  process.execPath,
  [path.join(webRoot, "scripts/generate-api-client.mjs")],
  {
    stdio: "inherit",
  },
);
if (generated.status !== 0) {
  process.exit(generated.status ?? 1);
}

const afterSchema = readFileSync(schemaPath, "utf8");
const afterClient = readFileSync(clientPath, "utf8");
if (beforeSchema !== afterSchema || beforeClient !== afterClient) {
  process.stderr.write(
    "The generated API client is stale. Run pnpm --filter @editagent/web generate:api and commit the result.\n",
  );
  process.exit(1);
}

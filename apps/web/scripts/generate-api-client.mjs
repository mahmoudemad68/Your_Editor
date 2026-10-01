import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(webRoot, "src/generated/schema.ts");
const clientPath = path.join(webRoot, "src/generated/client.ts");
const openApiPath = path.resolve(webRoot, "../../apps/api/dist/openapi.json");

const generated = spawnSync("pnpm", ["exec", "openapi-typescript", openApiPath, "-o", schemaPath], {
  cwd: webRoot,
  stdio: "inherit",
});
if (generated.status !== 0) {
  process.exit(generated.status ?? 1);
}

writeFileSync(
  clientPath,
  `/**
 * Generated from apps/api/dist/openapi.json. Do not edit by hand.
 * Regenerate with pnpm --filter @editagent/web generate:api.
 */
import createClient, { type Client } from "openapi-fetch";
import type { paths } from "./schema";

export type ApiPaths = paths;
export type GeneratedClient = Client<paths>;

export function createGeneratedClient(baseUrl: string, fetchImpl: typeof fetch = fetch): GeneratedClient {
  return createClient<paths>({ baseUrl, fetch: fetchImpl });
}
`,
);

const formatted = spawnSync("pnpm", ["exec", "prettier", "--write", schemaPath, clientPath], {
  cwd: webRoot,
  stdio: "inherit",
});
process.exit(formatted.status ?? 1);

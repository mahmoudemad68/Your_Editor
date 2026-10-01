/**
 * Generated from apps/api/dist/openapi.json. Do not edit by hand.
 * Regenerate with pnpm --filter @editagent/web generate:api.
 */
import createClient, { type Client } from "openapi-fetch";
import type { paths } from "./schema";

export type ApiPaths = paths;
export type GeneratedClient = Client<paths>;

export function createGeneratedClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): GeneratedClient {
  return createClient<paths>({ baseUrl, fetch: fetchImpl });
}

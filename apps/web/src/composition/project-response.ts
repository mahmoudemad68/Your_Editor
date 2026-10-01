import { NextResponse } from "next/server";

/** Browser and shared caches must not store Project envelopes, including 401. */
export const PROJECT_API_CACHE_CONTROL = "private, no-store";

export function projectApiResponse(body: unknown): NextResponse {
  const response = NextResponse.json(body);
  response.headers.set("Cache-Control", PROJECT_API_CACHE_CONTROL);
  return response;
}

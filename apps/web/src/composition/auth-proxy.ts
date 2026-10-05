import { loadWebConfig } from "../infrastructure/config";
import { CORRELATION_HEADER, createCorrelationId } from "@editagent/shared";

export type AuthAction = "register" | "login" | "refresh" | "logout" | "me";

/** Never derive an Origin or CSRF header from ambient cookies/forwarded hosts. */
export async function proxyAuth(
  request: Request,
  action: AuthAction,
  baseUrl = loadWebConfig().apiBaseUrl,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (
    action !== "me" &&
    (request.headers.get("sec-fetch-site") === "cross-site" ||
      (origin !== null && !sameOrigin(request, origin)))
  ) {
    return reply({ message: "This authentication request was refused." }, 403);
  }
  const headers = new Headers({ [CORRELATION_HEADER]: createCorrelationId() });
  for (const name of ["cookie", "x-editagent-csrf", "origin", "sec-fetch-site", "content-type"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  try {
    const upstream = await fetchImpl(`${baseUrl}/auth/${action}`, {
      method: action === "me" ? "GET" : "POST",
      headers,
      ...(action === "me" ? {} : { body: await request.text() }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const responseHeaders = new Headers({ "cache-control": "private, no-store" });
    responseHeaders.set("content-type", "application/json");
    // Fetch's getSetCookie preserves separate lines, including Expires commas.
    for (const cookie of upstream.headers.getSetCookie())
      responseHeaders.append("set-cookie", cookie);
    return new Response(upstream.status === 204 ? null : await upstream.text(), {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch {
    return reply({ message: "The authentication service could not be reached." }, 503);
  }
}

function reply(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

/** Next may construct request.url with its internal listener hostname. Compare
 * the browser authority against Host, never X-Forwarded-Host/Proto. The API
 * still receives the original Origin and applies its configured allow-list.
 */
function sameOrigin(request: Request, origin: string): boolean {
  try {
    const parsed = new URL(origin);
    const host = request.headers.get("host") ?? new URL(request.url).host;
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      parsed.origin === origin &&
      parsed.host === host
    );
  } catch {
    return false;
  }
}

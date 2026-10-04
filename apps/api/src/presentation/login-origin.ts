/**
 * Login and registration set the session cookie. A cross-site form must not
 * be able to inject that cookie. The browser Origin and Sec-Fetch-Site headers
 * are the decision. Forwarded host headers are not.
 */

const LOGIN_PATHS = new Set(["/auth/register", "/auth/login"]);

interface MutableRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
}

interface MutableResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body: string): void;
}

export function requireTrustedLoginOrigin(
  trustedOrigins: readonly string[],
): (request: MutableRequest, response: MutableResponse, next: () => void) => void {
  const allowed = new Set(trustedOrigins);
  return (request, response, next) => {
    const path = (request.url ?? "").split("?")[0] ?? "";
    if (!LOGIN_PATHS.has(path)) {
      next();
      return;
    }
    const fetchSite = headerValue(request.headers?.["sec-fetch-site"]);
    if (fetchSite === "cross-site") {
      reject(response);
      return;
    }
    const origin = headerValue(request.headers?.origin);
    if (origin !== undefined && !allowed.has(origin)) {
      reject(response);
      return;
    }
    next();
  };
}

function reject(response: MutableResponse): void {
  response.statusCode = 403;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ statusCode: 403, message: "This sign-in request was refused." }));
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

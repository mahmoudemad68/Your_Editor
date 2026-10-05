import { CSRF_COOKIE, CSRF_HEADER, csrfMatches, readCookie } from "./auth-cookies.js";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

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

/**
 * Cookie-authenticated mutations must echo the CSRF cookie.
 * Bearer tokens are not sent by browsers automatically, so they skip this check.
 * The login and registration exemption is an exact path. Other spellings stay
 * on this check, which refuses a cookie-authenticated mutation that lacks the
 * token. Login origin protection is the handler guard, not this exemption.
 */
export function requireCookieCsrf(): (
  request: MutableRequest,
  response: MutableResponse,
  next: () => void,
) => void {
  return (request, response, next) => {
    const method = request.method ?? "GET";
    if (SAFE.has(method)) {
      next();
      return;
    }
    const path = (request.url ?? "").split("?")[0] ?? "";
    if (path === "/auth/register" || path === "/auth/login") {
      next();
      return;
    }
    const authorization = headerValue(request.headers?.authorization);
    if (authorization?.startsWith("Bearer ")) {
      next();
      return;
    }
    const cookies = headerValue(request.headers?.cookie);
    const access = readCookie(cookies, "editagent_access");
    if (access === undefined) {
      next();
      return;
    }
    if (
      !csrfMatches(headerValue(request.headers?.[CSRF_HEADER]), readCookie(cookies, CSRF_COOKIE))
    ) {
      response.statusCode = 403;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ statusCode: 403, message: "CSRF token is missing." }));
      return;
    }
    next();
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

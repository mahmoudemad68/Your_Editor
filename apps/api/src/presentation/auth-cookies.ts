import { timingSafeEqual } from "node:crypto";

export const ACCESS_COOKIE = "editagent_access";
export const REFRESH_COOKIE = "editagent_refresh";
export const CSRF_COOKIE = "editagent_csrf";
export const CSRF_HEADER = "x-editagent-csrf";

interface CookieOptions {
  readonly httpOnly: boolean;
  readonly maxAgeSeconds: number;
  readonly path: string;
  readonly secure: boolean;
}

export function sessionCookies(
  session: {
    readonly accessToken: string;
    readonly accessExpiresAt: bigint;
    readonly refreshToken: string;
    readonly refreshExpiresAt: bigint;
    readonly csrfToken: string;
  },
  now: bigint,
  secure: boolean,
): readonly string[] {
  return [
    serializeCookie(ACCESS_COOKIE, session.accessToken, {
      httpOnly: true,
      maxAgeSeconds: secondsUntil(session.accessExpiresAt, now),
      path: "/",
      secure,
    }),
    serializeCookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true,
      maxAgeSeconds: secondsUntil(session.refreshExpiresAt, now),
      path: "/auth",
      secure,
    }),
    serializeCookie(CSRF_COOKIE, session.csrfToken, {
      httpOnly: false,
      maxAgeSeconds: secondsUntil(session.refreshExpiresAt, now),
      path: "/",
      secure,
    }),
  ];
}

export function clearSessionCookies(secure: boolean): readonly string[] {
  const expired = { httpOnly: true, maxAgeSeconds: 0, path: "/", secure };
  return [
    serializeCookie(ACCESS_COOKIE, "", expired),
    serializeCookie(REFRESH_COOKIE, "", { ...expired, path: "/auth" }),
    serializeCookie(CSRF_COOKIE, "", { ...expired, httpOnly: false }),
  ];
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return undefined;
}

export function csrfMatches(header: string | undefined, cookie: string | undefined): boolean {
  if (header === undefined || cookie === undefined || header.length === 0 || cookie.length === 0) {
    return false;
  }
  const left = Buffer.from(header);
  const right = Buffer.from(cookie);
  return left.length === right.length && timingSafeEqual(left, right);
}

function secondsUntil(expiresAt: bigint, now: bigint): number {
  const delta = expiresAt > now ? Number((expiresAt - now) / 1000n) : 0;
  return delta;
}

function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${options.maxAgeSeconds}`,
    `Path=${options.path}`,
    "SameSite=Lax",
  ];
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

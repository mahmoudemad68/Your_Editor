import { type UserId } from "@editagent/domain";
import { type SessionTokens } from "../application/session-tokens.js";
import { bindActor } from "./actor.js";
import { ACCESS_COOKIE, readCookie } from "./auth-cookies.js";

interface HeaderRequest {
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Binds the caller only after an access token verifies.
 * It does not accept a caller-supplied user id from a header or the body.
 */
export function authenticateRequest(
  tokens: SessionTokens,
  now: () => bigint,
): (request: object, response: unknown, next: () => void) => void {
  return (request, _response, next) => {
    void verify(request, tokens, now).then(
      (actor) => {
        if (actor !== null) {
          bindActor(request, actor);
        }
        next();
      },
      () => {
        next();
      },
    );
  };
}

async function verify(
  request: object,
  tokens: SessionTokens,
  now: () => bigint,
): Promise<UserId | null> {
  const headers = (request as HeaderRequest).headers;
  const authorization = headerValue(headers?.authorization);
  if (authorization?.startsWith("Bearer ")) {
    return tokens.verifyAccess(authorization.slice("Bearer ".length).trim(), now());
  }
  const cookie = readCookie(headerValue(headers?.cookie), ACCESS_COOKIE);
  if (cookie === undefined) {
    return null;
  }
  return tokens.verifyAccess(cookie, now());
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

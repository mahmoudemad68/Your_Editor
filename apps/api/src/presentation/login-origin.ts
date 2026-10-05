/**
 * Login and registration set the session cookie. The guard is attached to
 * those handlers, so every URL Express routes to them is covered. A raw path
 * comparison is not the control: `/auth/login/`, `/AUTH/LOGIN`, and a query
 * string all reach the same handler.
 * The browser Origin and Sec-Fetch-Site headers are the decision.
 * Forwarded host headers are not.
 */

import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";

export const AUTH_TRUSTED_ORIGINS = "AUTH_TRUSTED_ORIGINS";

const REFUSAL = "This sign-in request was refused.";

interface HeaderBag {
  headers?: Record<string, string | string[] | undefined>;
}

export function assertTrustedLoginOrigin(
  headers: Record<string, string | string[] | undefined> | undefined,
  trustedOrigins: readonly string[],
): void {
  const allowed = new Set(trustedOrigins);
  if (headerValue(headers?.["sec-fetch-site"]) === "cross-site") {
    throw new ForbiddenException(REFUSAL);
  }
  const origin = headerValue(headers?.origin);
  if (origin !== undefined && !allowed.has(origin)) {
    throw new ForbiddenException(REFUSAL);
  }
}

@Injectable()
export class LoginOriginGuard implements CanActivate {
  constructor(@Inject(AUTH_TRUSTED_ORIGINS) private readonly trustedOrigins: readonly string[]) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<HeaderBag>();
    assertTrustedLoginOrigin(request.headers, this.trustedOrigins);
    return true;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

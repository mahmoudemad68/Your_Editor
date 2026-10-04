import { type UserId } from "@editagent/domain";

export interface IssuedAccessToken {
  readonly token: string;
  readonly expiresAt: bigint;
}

/** Signs and checks short-lived access tokens. The raw refresh secret is not a JWT. */
export interface SessionTokens {
  issueAccess(userId: UserId, now: bigint): Promise<IssuedAccessToken>;
  verifyAccess(token: string, now: bigint): Promise<UserId | null>;
}

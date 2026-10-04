import { type UserId, userId } from "@editagent/domain";
import { jwtVerify, SignJWT } from "jose";
import { type IssuedAccessToken, type SessionTokens } from "../application/session-tokens.js";

const ACCESS_TTL_SECONDS = 15 * 60;

/** HS256 access tokens. The signing key comes from configuration, not from source. */
export class JwtSessionTokens implements SessionTokens {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  async issueAccess(actor: UserId, now: bigint): Promise<IssuedAccessToken> {
    const issuedAt = Math.floor(Number(now) / 1000);
    const expiresAtSeconds = issuedAt + ACCESS_TTL_SECONDS;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(actor)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAtSeconds)
      .sign(this.key);
    return { token, expiresAt: BigInt(expiresAtSeconds) * 1000n };
  }

  async verifyAccess(token: string, now: bigint): Promise<UserId | null> {
    try {
      const verified = await jwtVerify(token, this.key, {
        algorithms: ["HS256"],
        currentDate: new Date(Number(now)),
      });
      const subject = verified.payload.sub;
      if (subject === undefined) {
        return null;
      }
      return userId(subject);
    } catch {
      return null;
    }
  }
}

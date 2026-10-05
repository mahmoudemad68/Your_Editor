import { GetCurrentUser } from "./application/current-user.js";
/**
 * Minimal production auth process for cross-process race tests.
 * It uses the same Postgres repositories and use cases as main.ts.
 */
import "reflect-metadata";
import { instant, type Instant } from "@editagent/domain";
import { Pool } from "pg";
import {
  LoginUser,
  LogoutUser,
  RefreshAccess,
  RegisterUser,
} from "./application/authentication.js";
import { LoginRateLimit } from "./application/login-rate-limit.js";
import { InMemoryMediaAssetRepository } from "./application/in-memory-media-repository.js";
import { MemoryObjectStorage } from "./application/memory-object-storage.js";
import { createApiApplication } from "./create-api-application.js";
import { Argon2idHasher } from "./infrastructure/argon2id-hasher.js";
import { loadApiConfig } from "./infrastructure/config.js";
import { JwtSessionTokens } from "./infrastructure/jwt-session-tokens.js";
import { NodeMediaAssetIdGenerator } from "./infrastructure/node-media-asset-id-generator.js";
import { NodeProjectIdGenerator } from "./infrastructure/node-project-id-generator.js";
import {
  PostgresRefreshSessionRepository,
  PostgresUserRepository,
} from "./infrastructure/postgres-identity-repository.js";
import {
  type RefreshRotation,
  type RefreshSession,
  type RefreshSessionRepository,
  type RotationDecision,
} from "@editagent/domain";
import { PostgresProjectRepository } from "./infrastructure/postgres-project-repository.js";
import { type Clock } from "./application/clock.js";

class SkewedClock implements Clock {
  constructor(private readonly skewMs: bigint) {}

  now(): Instant {
    const value = BigInt(Date.now()) + this.skewMs;
    return instant(value < 0n ? 0n : value);
  }
}

async function main(): Promise<void> {
  const config = loadApiConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  const clock = new SkewedClock(BigInt(config.authClockSkewMs));
  const users = new PostgresUserRepository(pool);
  const sessions = withPostCommitDelay(
    new PostgresRefreshSessionRepository(pool),
    config.authPostCommitDelayMs,
  );
  const passwords = new Argon2idHasher();
  const tokens = new JwtSessionTokens(config.authJwtSecret);
  const rateLimit = new LoginRateLimit(100_000, 60_000);
  const app = await createApiApplication({
    projects: new PostgresProjectRepository(pool),
    clock,
    ids: new NodeProjectIdGenerator(),
    media: new InMemoryMediaAssetRepository(),
    objects: new MemoryObjectStorage(),
    mediaIds: new NodeMediaAssetIdGenerator(),
    presignTtlSeconds: 900,
    auth: {
      currentUser: new GetCurrentUser(users),
      register: new RegisterUser(users, sessions, passwords, tokens, clock, rateLimit),
      login: new LoginUser(users, sessions, passwords, tokens, clock, rateLimit),
      refresh: new RefreshAccess(users, sessions, tokens, clock),
      logout: new LogoutUser(sessions, clock),
      tokens,
      now: () => clock.now(),
      cookieSecure: config.authCookieSecure,
      trustedOrigins: config.authTrustedOrigins,
      trustedProxies: config.authTrustedProxies,
    },
  });
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a port");
  }
  process.stdout.write(`AUTH_SERVER_READY port=${address.port}\n`);
}

function withPostCommitDelay(
  inner: PostgresRefreshSessionRepository,
  delayMs: number,
): RefreshSessionRepository {
  if (delayMs === 0) {
    return inner;
  }
  return {
    findById: (id) => inner.findById(id),
    save: (session) => inner.save(session),
    revokeAllForUser: (userId, revokedAt) => inner.revokeAllForUser(userId, revokedAt),
    endSession: (sessionId, now, presentedSecretHash) =>
      inner.endSession(sessionId, now, presentedSecretHash),
    rotate: async (
      sessionId: string,
      now: bigint,
      decide: (current: RefreshSession | null) => RotationDecision | Promise<RotationDecision>,
      beforeCommit?: (replacement: RefreshSession) => Promise<void>,
    ): Promise<RefreshRotation> => {
      const result = await inner.rotate(sessionId, now, decide, beforeCommit);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return result;
    },
  };
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

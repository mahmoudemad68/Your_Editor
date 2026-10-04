/**
 * Minimal production auth process for cross-process race tests.
 * It uses the same Postgres repositories and use cases as main.ts.
 */
import "reflect-metadata";
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
import { PostgresProjectRepository } from "./infrastructure/postgres-project-repository.js";
import { SystemClock } from "./infrastructure/system-clock.js";

async function main(): Promise<void> {
  const config = loadApiConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  const clock = new SystemClock();
  const users = new PostgresUserRepository(pool);
  const sessions = new PostgresRefreshSessionRepository(pool);
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
      register: new RegisterUser(users, sessions, passwords, tokens, clock, rateLimit),
      login: new LoginUser(users, sessions, passwords, tokens, clock, rateLimit),
      refresh: new RefreshAccess(users, sessions, tokens, clock),
      logout: new LogoutUser(sessions, clock),
      tokens,
      now: () => clock.now(),
      cookieSecure: config.authCookieSecure,
    },
  });
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a port");
  }
  process.stdout.write(`AUTH_SERVER_READY port=${address.port}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

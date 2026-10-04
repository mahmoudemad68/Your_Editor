import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  LoginUser,
  LogoutUser,
  RefreshAccess,
  RegisterUser,
} from "./application/authentication.js";
import {
  InMemoryRefreshSessionRepository,
  InMemoryUserRepository,
} from "./application/in-memory-identity.js";
import { InMemoryMediaAssetRepository } from "./application/in-memory-media-repository.js";
import { InMemoryProjectRepository } from "./application/in-memory-project-repository.js";
import { LoginRateLimit } from "./application/login-rate-limit.js";
import { MemoryObjectStorage } from "./application/memory-object-storage.js";
import { createOpenApiDocument } from "./create-api-application.js";
import { Argon2idHasher } from "./infrastructure/argon2id-hasher.js";
import { JwtSessionTokens } from "./infrastructure/jwt-session-tokens.js";
import { NodeMediaAssetIdGenerator } from "./infrastructure/node-media-asset-id-generator.js";
import { NodeProjectIdGenerator } from "./infrastructure/node-project-id-generator.js";
import { SystemClock } from "./infrastructure/system-clock.js";

/** Document generation only. The API process reads AUTH_JWT_SECRET instead. */
const DOCUMENT_SIGNING_KEY = "openapi-document-signing-key-32chars";

async function main(): Promise<void> {
  const clock = new SystemClock();
  const passwords = new Argon2idHasher();
  const tokens = new JwtSessionTokens(DOCUMENT_SIGNING_KEY);
  const users = new InMemoryUserRepository();
  const sessions = new InMemoryRefreshSessionRepository();
  const rateLimit = new LoginRateLimit(30, 60_000);
  const document = await createOpenApiDocument({
    projects: new InMemoryProjectRepository(),
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
      cookieSecure: false,
    },
  });
  const target = path.resolve(__dirname, "openapi.json");
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

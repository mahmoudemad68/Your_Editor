import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { createUuidV7 } from "@editagent/domain";
import {
  BullMqJobQueue,
  observePostgresPool,
  PostgresJobRepository,
  postgresAndRedisReady,
} from "@editagent/job-queue";
import { createServiceLogger, startNoopTracing } from "@editagent/shared";
import { Pool } from "pg";
import {
  LoginUser,
  LogoutUser,
  RefreshAccess,
  RegisterUser,
} from "./application/authentication.js";
import { LoginRateLimit } from "./application/login-rate-limit.js";
import { createApiApplication } from "./create-api-application.js";
import { Argon2idHasher } from "./infrastructure/argon2id-hasher.js";
import { ConfigurationError, loadApiConfig } from "./infrastructure/config.js";
import { JwtSessionTokens } from "./infrastructure/jwt-session-tokens.js";
import {
  PostgresRefreshSessionRepository,
  PostgresUserRepository,
} from "./infrastructure/postgres-identity-repository.js";
import { applyMigrations } from "./infrastructure/migrate.js";
import { NodeMediaAssetIdGenerator } from "./infrastructure/node-media-asset-id-generator.js";
import { NodeProjectIdGenerator } from "./infrastructure/node-project-id-generator.js";
import { PostgresMediaAssetRepository } from "./infrastructure/postgres-media-repository.js";
import { PostgresProjectRepository } from "./infrastructure/postgres-project-repository.js";
import {
  PostgresUploadPublication,
  startPublicationRecovery,
} from "./infrastructure/postgres-upload-publication.js";
import { S3ObjectStorage } from "./infrastructure/s3-object-storage.js";
import { SystemClock } from "./infrastructure/system-clock.js";

export async function bootstrap(): Promise<void> {
  startNoopTracing("api");
  const logger = createServiceLogger("api");
  const config = loadApiConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  observePostgresPool(pool, (error) => {
    logger.error({ err: error.message }, "postgres.pool.disconnected");
  });
  await applyMigrations(pool);
  const clock = new SystemClock();
  const users = new PostgresUserRepository(pool);
  const sessions = new PostgresRefreshSessionRepository(pool);
  const passwords = new Argon2idHasher();
  const tokens = new JwtSessionTokens(config.authJwtSecret);
  const rateLimit = new LoginRateLimit(30, 60_000);
  const auth = {
    register: new RegisterUser(users, sessions, passwords, tokens, clock, rateLimit),
    login: new LoginUser(users, sessions, passwords, tokens, clock, rateLimit),
    refresh: new RefreshAccess(users, sessions, tokens, clock),
    logout: new LogoutUser(sessions, clock),
    tokens,
    now: () => clock.now(),
    cookieSecure: config.authCookieSecure,
    trustedOrigins: config.authTrustedOrigins,
    trustedProxies: config.authTrustedProxies,
  };
  const jobs = new PostgresJobRepository(pool);
  const queue = new BullMqJobQueue(config.redisUrl);
  const publication = new PostgresUploadPublication({
    pool,
    jobs,
    queue,
    now: () => clock.now(),
    newJobId: () => createUuidV7(Date.now(), randomBytes(10)),
    newAttemptId: () => createUuidV7(Date.now(), randomBytes(10)),
    queueName: config.mediaInspectQueue,
    workerId: `api-${randomBytes(8).toString("hex")}`,
  });
  startPublicationRecovery(publication);
  const app = await createApiApplication({
    projects: new PostgresProjectRepository(pool),
    clock,
    ids: new NodeProjectIdGenerator(),
    media: new PostgresMediaAssetRepository(pool),
    objects: new S3ObjectStorage(config.objectStorage),
    mediaIds: new NodeMediaAssetIdGenerator(),
    presignTtlSeconds: config.objectStorage.presignTtlSeconds,
    logger,
    readiness: {
      check: () => postgresAndRedisReady(pool, config.redisUrl),
    },
    publication,
    auth,
  });
  await app.listen(config.port, config.host);
}

if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    if (error instanceof ConfigurationError) {
      process.stderr.write(`${error.message}\n`);
    } else if (error instanceof Error) {
      process.stderr.write(`${error.stack ?? error.message}\n`);
    } else {
      process.stderr.write(`${String(error)}\n`);
    }
    process.exitCode = 1;
  });
}

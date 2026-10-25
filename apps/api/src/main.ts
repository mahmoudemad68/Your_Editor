import { PostgresInspectionJobs } from "./infrastructure/postgres-inspection-jobs.js";
import { PostgresAgentRuns } from "@editagent/agent-core";
import { PostgresAnalysis } from "@editagent/analysis-core";
import { RedisJobEventPublisher, RedisJobEventSubscriber } from "@editagent/job-queue";
import { PostgresUploadSessionRepository } from "./infrastructure/postgres-upload-sessions.js";
import { GetCurrentUser } from "./application/current-user.js";
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
import { PostgresDerivedAssetReader } from "./infrastructure/postgres-derived-asset-reader.js";
import { PostgresProjectRepository } from "./infrastructure/postgres-project-repository.js";
import {
  PostgresUploadPublication,
  startPublicationRecovery,
} from "./infrastructure/postgres-upload-publication.js";
import { S3ObjectStorage } from "./infrastructure/s3-object-storage.js";
import { SystemClock } from "./infrastructure/system-clock.js";
import { TimelineEditor } from "./application/timeline-editor.js";
import { TimelineExports } from "./application/timeline-exports.js";
import { GetMediaDetails } from "./application/media-details.js";

export async function bootstrap(): Promise<void> {
  startNoopTracing("api");
  const logger = createServiceLogger("api");
  const config = loadApiConfig();
  const [{ PostgresTimelineStore }, { PostgresTimelineRenders }, { timelineProposals }] =
    await Promise.all([
      import("./infrastructure/postgres-timeline-store.js"),
      import("./infrastructure/postgres-timeline-renders.js"),
      import("./infrastructure/timeline-proposals.js"),
    ]);
  const pool = new Pool({ connectionString: config.databaseUrl });
  observePostgresPool(pool, () => {
    logger.error({ errorCode: "postgres_connection_lost" }, "postgres.pool.disconnected");
  });
  await applyMigrations(pool);
  const clock = new SystemClock();
  const users = new PostgresUserRepository(pool);
  const sessions = new PostgresRefreshSessionRepository(pool);
  const passwords = new Argon2idHasher();
  const tokens = new JwtSessionTokens(config.authJwtSecret);
  const rateLimit = new LoginRateLimit(30, 60_000);
  const auth = {
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
  };
  const jobs = new PostgresJobRepository(pool);
  const queue = new BullMqJobQueue(config.redisUrl, {
    events: new RedisJobEventPublisher(pool, config.redisUrl),
  });
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
  const recovery = startPublicationRecovery(publication);
  const projects = new PostgresProjectRepository(pool),
    media = new PostgresMediaAssetRepository(pool);
  const objects = new S3ObjectStorage(config.objectStorage);
  const timelines = new PostgresTimelineStore(pool);
  const editor = new TimelineEditor(
    projects,
    new GetMediaDetails(projects, media),
    timelines,
    timelineProposals(pool, timelines),
    clock,
    () => createUuidV7(Date.now(), randomBytes(10)),
  );
  const renders = new PostgresTimelineRenders(
    pool,
    {
      jobs,
      queue,
      now: () => clock.now(),
      newAttemptId: () => createUuidV7(Date.now(), randomBytes(10)),
      supervisor: {
        async run() {
          throw new Error("API does not execute Jobs.");
        },
      },
    },
    config.renderVersion,
  );
  const app = await createApiApplication({
    agentRuns: new PostgresAgentRuns(pool),
    editor,
    timelineExports: new TimelineExports(projects, editor, renders, objects, (key, ttl) =>
      objects.presignDownload(key, ttl),
    ),
    analysis: new PostgresAnalysis(pool),
    jobEvents: new RedisJobEventSubscriber(config.redisUrl, logger),
    inspectionJobs: new PostgresInspectionJobs(
      pool,
      {
        jobs,
        queue,
        now: () => clock.now(),
        newAttemptId: () => createUuidV7(Date.now(), randomBytes(10)),
        supervisor: {
          async run() {
            throw new Error("API does not execute Jobs.");
          },
        },
      },
      {
        queueName: config.mediaInspectQueue,
        policy: config.validationPolicy,
        newJobId: () => createUuidV7(Date.now(), randomBytes(10)),
      },
    ),
    projects,
    clock,
    ids: new NodeProjectIdGenerator(),
    media,
    derivedAssets: new PostgresDerivedAssetReader(pool),
    objects,
    mediaIds: new NodeMediaAssetIdGenerator(),
    presignTtlSeconds: config.objectStorage.presignTtlSeconds,
    uploadSessions: new PostgresUploadSessionRepository(pool),
    logger,
    readiness: {
      check: () => postgresAndRedisReady(pool, config.redisUrl),
    },
    publication,
    auth,
  });
  const cleanup = async () => {
    recovery.stop();
    await app.close();
    await queue.close(true);
    await pool.end();
  };
  process.once("SIGTERM", () => {
    void cleanup();
  });
  process.once("SIGINT", () => {
    void cleanup();
  });
  await app.listen(config.port, config.host);
}

if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    if (error instanceof ConfigurationError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      createServiceLogger("api").error({ errorCode: "startup_failed" }, "service.startup.failed");
    }
    process.exitCode = 1;
  });
}

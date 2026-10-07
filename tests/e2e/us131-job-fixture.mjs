/** Test-only durable composition. No controls are present in production. */
import { createRequire } from "node:module";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const { Pool } = require("pg");
const { createUuidV7, instant } = require("@editagent/domain");
const { parseValidationPolicy } = require("@editagent/shared");
const {
  BullMqJobQueue,
  PostgresJobRepository,
  RedisJobEventPublisher,
  RedisJobEventSubscriber,
} = require("@editagent/job-queue");
const { applyMigrations } = require("./dist/infrastructure/migrate.js");
const {
  PostgresProjectRepository,
} = require("./dist/infrastructure/postgres-project-repository.js");
const {
  PostgresMediaAssetRepository,
} = require("./dist/infrastructure/postgres-media-repository.js");
const {
  PostgresRefreshSessionRepository,
  PostgresUserRepository,
} = require("./dist/infrastructure/postgres-identity-repository.js");
const { PostgresInspectionJobs } = require("./dist/infrastructure/postgres-inspection-jobs.js");
const {
  PostgresUploadPublication,
} = require("./dist/infrastructure/postgres-upload-publication.js");
const newId = () => createUuidV7(Date.now(), randomBytes(10));
export async function createJobFixture() {
  const adminUrl =
    process.env.DATABASE_URL ??
    "postgresql://editagent:editagent-dev-password@127.0.0.1:5432/editagent";
  const admin = new Pool({ connectionString: adminUrl });
  const db = `editagent_us131_browser_${process.pid}`;
  await admin.query(`CREATE DATABASE ${db}`);
  const url = new URL(adminUrl);
  url.pathname = `/${db}`;
  const pool = new Pool({ connectionString: url.toString() });
  await applyMigrations(pool);
  const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379/0";
  const queue = new BullMqJobQueue(redisUrl, {
    events: new RedisJobEventPublisher(pool, redisUrl),
  });
  const jobs = new PostgresJobRepository(pool),
    queueName = `us131-browser-${process.pid}`;
  const now = () => instant(BigInt(Date.now()));
  const subscriber = new RedisJobEventSubscriber(redisUrl);
  const deps = { jobs, queue, now, newAttemptId: newId, supervisor: { async run() {} } };
  const events = [],
    subscriptions = [];
  const composition = {
    projects: new PostgresProjectRepository(pool),
    media: new PostgresMediaAssetRepository(pool),
    jobEvents: subscriber,
    inspectionJobs: new PostgresInspectionJobs(pool, deps, {
      queueName,
      policy: parseValidationPolicy(process.env),
      newJobId: newId,
    }),
    publication: new PostgresUploadPublication({
      pool,
      jobs,
      queue,
      now,
      newJobId: newId,
      newAttemptId: newId,
      queueName,
      workerId: "us131-browser",
    }),
  };
  return {
    users: new PostgresUserRepository(pool),
    sessions: new PostgresRefreshSessionRepository(pool),
    composition,
    async observe(projectId) {
      subscriptions.push(await subscriber.subscribe(projectId, (event) => events.push(event)));
    },
    async run(mode) {
      await new Promise((resolve, reject) => {
        const child = fork(fileURLToPath(new URL("./us131-worker.mjs", import.meta.url)), [], {
          env: {
            ...process.env,
            DATABASE_URL: url.toString(),
            REDIS_URL: redisUrl,
            MEDIA_INSPECT_QUEUE: queueName,
          },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        let error = "";
        child.stderr.on("data", (chunk) => {
          error += chunk;
        });
        child.send({ queueName, mode });
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(error))));
      });
    },
    async evidence() {
      const result = await pool.query(
        `SELECT id::text, status, subject_id::text, idempotency_key, timeout_ms, max_attempts, attempt_count, created_at::text, updated_at::text FROM jobs ORDER BY created_at, id`,
      );
      return { jobs: result.rows, events };
    },
    async close() {
      for (const sub of subscriptions) await sub.close();
      await queue.close();
      await pool.end();
      await admin.query(`DROP DATABASE ${db}`);
      await admin.end();
    },
  };
}

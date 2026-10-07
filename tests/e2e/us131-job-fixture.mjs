/** Test-only durable composition. No controls are present in production. */
import { createRequire } from "node:module";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRedisTransportProxy } from "./redis-transport-proxy.mjs";
const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const { Pool } = require("pg");
const { Redis } = require("ioredis");
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
  const transport = await createRedisTransportProxy(redisUrl);
  const subscriber = new RedisJobEventSubscriber(transport.url);
  const monitor = new Redis(redisUrl);
  const deps = { jobs, queue, now, newAttemptId: newId, supervisor: { async run() {} } };
  const events = [],
    reports = [],
    subscriptions = [];
  let readyAt = null;
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
    async transportState() {
      return {
        ...transport.state(),
        readyAt,
        subscriptions: subscriber.subscriptionCount,
        redisChannels: (await monitor.pubsub("CHANNELS", "editagent:project-job-events:*")).length,
      };
    },
    async resetTransport(action) {
      if (action === "break") return { lostAt: transport.break() };
      transport.restore();
      // A genuine SUBSCRIBE acknowledgement proves Redis is ready again.
      const probe = await subscriber.subscribe(newId(), () => {});
      readyAt = Date.now();
      await probe.close();
      return { readyAt };
    },
    async revokeMembership(projectId, email) {
      const user = await pool.query("SELECT id FROM users WHERE email=$1", [email]);
      // Preserve the Project invariant: revocation cannot delete its last Owner.
      // Transfer ownership to an independent fixture user before removing access.
      const owner = newId();
      await pool.query(
        "INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES($1,$2,'$argon2id$fixture',1,1)",
        [owner, `${owner}@example.test`],
      );
      await pool.query(
        "INSERT INTO project_memberships(project_id,user_id,role,created_at) SELECT id,$2,'owner',created_at FROM projects WHERE id=$1",
        [projectId, owner],
      );
      await pool.query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2", [
        projectId,
        user.rows[0].id,
      ]);
    },
    async runProduction() {
      const child = fork(
        fileURLToPath(new URL("../../workers/media-worker/dist/index.js", import.meta.url)),
        [],
        {
          env: {
            ...process.env,
            DATABASE_URL: url.toString(),
            REDIS_URL: redisUrl,
            MEDIA_INSPECT_QUEUE: queueName,
            WORKER_HEALTH_PORT: "3139",
          },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const exited = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code, signal) => resolve({ code, signal }));
      });
      try {
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          const latest = (
            await pool.query("SELECT status FROM jobs ORDER BY created_at DESC,id DESC LIMIT 1")
          ).rows[0];
          if (latest?.status === "Completed")
            return { completedAt: Date.now(), status: latest.status };
          if (latest?.status === "Failed" || child.exitCode !== null)
            throw new Error(`Production fixture worker failed: ${stderr}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("Production fixture worker timed out.");
      } finally {
        child.kill("SIGTERM");
        await exited;
      }
    },
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
        child.on("message", (report) => {
          if (report.type === "progress-reported") reports.push(report);
        });
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(error))));
      });
    },
    async evidence() {
      const result = await pool.query(
        `SELECT id::text, status, subject_id::text, idempotency_key, timeout_ms, max_attempts, attempt_count, created_at::text, updated_at::text FROM jobs ORDER BY created_at, id`,
      );
      return { jobs: result.rows, events, reports };
    },
    async close() {
      for (const sub of subscriptions) await sub.close();
      await queue.close();
      await subscriber.close();
      monitor.disconnect();
      await transport.close();
      await pool.end();
      await admin.query(`DROP DATABASE ${db}`);
      await admin.end();
    },
  };
}

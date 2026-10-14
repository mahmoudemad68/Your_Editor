import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { startPostgres, startRedis } from "./support/containers.mjs";

const root = path.resolve(import.meta.dirname, "../.."),
  require = createRequire(path.join(root, "apps/api/package.json"));
const { createUuidV7, projectId, userId } = require("@editagent/domain");
const { RedisJobEventSubscriber } = require("@editagent/job-queue");
const {
  PostgresProjectRepository,
} = require("./dist/infrastructure/postgres-project-repository.js");
const { ProjectJobEvents } = require("./dist/application/job-events.js");
const { JobEventsController } = require("./dist/presentation/job-events.controller.js");
const { ProjectNotFoundError } = require("./dist/application/project-access.js");
const { bindActor } = require("./dist/presentation/actor.js");

test(
  "real PostgreSQL/Redis SSE admission rechecks revocation after a delayed SUBSCRIBE acknowledgement",
  { timeout: 120000 },
  async () => {
    let pg, redis, bootstrap, pool, subscriber, events, server, release;
    const namespace = "admission_" + randomUUID().replaceAll("-", "");
    try {
      if (!process.env.DATABASE_URL) pg = await startPostgres();
      if (!process.env.REDIS_URL) redis = await startRedis();
      const url = pg?.url ?? process.env.DATABASE_URL;
      bootstrap = new Pool({ connectionString: url });
      await bootstrap.query(`CREATE SCHEMA ${namespace}`);
      pool = new Pool({ connectionString: url, options: `-c search_path=${namespace}` });
      for (const file of (await readdir(path.join(root, "apps/api/migrations")))
        .filter((f) => f.endsWith(".sql"))
        .sort())
        await pool.query(await readFile(path.join(root, "apps/api/migrations", file), "utf8"));
      const id = () => createUuidV7(Date.now(), randomBytes(10)),
        owner = id(),
        actor = id(),
        project = id();
      for (const user of [owner, actor])
        await pool.query(
          "INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES($1,$2,'$argon2id$fixture',0,0)",
          [user, user + "@example.test"],
        );
      await pool.query(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Admission fixture',0,0)",
        [project],
      );
      for (const [user, role] of [
        [owner, "owner"],
        [actor, "editor"],
      ])
        await pool.query(
          "INSERT INTO project_memberships(project_id,user_id,role,created_at) VALUES($1,$2,$3,0)",
          [project, user, role],
        );
      subscriber = new RedisJobEventSubscriber(redis?.url ?? process.env.REDIS_URL);
      let observed;
      const admitted = new Promise((resolve) => {
        observed = resolve;
      });
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      events = new ProjectJobEvents(new PostgresProjectRepository(pool), {
        async subscribe(...args) {
          const subscription = await subscriber.subscribe(...args); // actual Redis ACK
          observed();
          await gate;
          return subscription;
        },
        close: () => subscriber.close(),
      });
      const controller = new JobEventsController(events);
      server = createServer((request, response) => {
        bindActor(request, userId(actor));
        void controller.stream(projectId(project), request, response).catch((error) => {
          assert.equal(error instanceof ProjectNotFoundError, true);
          assert.equal(response.headersSent, false, "Revoked admission must not first emit 200");
          response.writeHead(404, { "content-type": "application/json" });
          response.end('{"message":"Project not found."}');
        });
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const response = fetch(`http://127.0.0.1:${server.address().port}/events`, {
        signal: globalThis.AbortSignal.timeout(10000),
      });
      await admitted;
      await pool.query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2", [
        project,
        actor,
      ]);
      release();
      const result = await response;
      try {
        assert.equal(result.status, 404);
        assert.equal((await result.json()).message, "Project not found.");
      } finally {
        await result.body?.cancel().catch(() => {});
      }
      assert.equal(subscriber.subscriptionCount, 0);
      console.log(
        "SSE_ADMISSION_RECHECK",
        JSON.stringify({
          status: 404,
          subscriptions: subscriber.subscriptionCount,
          realPostgres: true,
          realRedisAcknowledgement: true,
          authorizedBeforeRevocation: true,
          no200Before404: true,
        }),
      );
    } finally {
      release?.();
      await events?.onModuleDestroy();
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      await subscriber?.close();
      await pool?.end();
      if (bootstrap) {
        await bootstrap.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
        await bootstrap.end();
      }
      await redis?.close();
      await pg?.close();
    }
  },
);

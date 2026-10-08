/** B2-01: real pooled-client reuse, dependency outages and HTTP readiness. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate, setTimeout, clearTimeout } from "node:timers";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { startPostgres, startRedis } from "./support/containers.mjs";
const require = createRequire(new URL("../../packages/job-queue/package.json", import.meta.url));
const { Pool } = require("pg");
const {
  postgresAndRedisReady,
  observePostgresPool,
  READINESS_DEADLINE_MS,
} = require("../../packages/job-queue/dist/index.js");
const { startHealthServer } = require("../../packages/shared/dist/index.js");

test(
  "500 real readiness probes retain no client listeners; paused/stopped PostgreSQL fails safely",
  { timeout: 120000 },
  async () => {
    const warnings = [];
    const capture = (warning) => {
      if (warning.name === "MaxListenersExceededWarning") warnings.push(warning);
    };
    process.on("warning", capture);
    let pg,
      redis,
      pool,
      server,
      paused = false;
    try {
      const started = await Promise.allSettled([startPostgres(), startRedis()]);
      if (started[0].status === "fulfilled") pg = started[0].value;
      if (started[1].status === "fulfilled") redis = started[1].value;
      assert.ok(pg && redis, "Readiness test infrastructure must start");
      pool = new Pool({
        connectionString: pg.url,
        max: 1,
        connectionTimeoutMillis: READINESS_DEADLINE_MS,
      });
      let idleErrors = 0;
      observePostgresPool(pool, () => idleErrors++);
      const clients = [];
      pool.on("connect", (client) => clients.push(client));
      const client = await pool.connect();
      const baseline = client.listenerCount("error");
      client.release();
      const idleBaseline = client.listenerCount("error");
      const idleListeners = client.listeners("error");
      for (let i = 0; i < 500; i++)
        assert.equal(await postgresAndRedisReady(pool, redis.url), true);
      const reused = await pool.connect();
      assert.equal(reused, client);
      const final = reused.listenerCount("error");
      assert.equal(final, baseline);
      reused.release();
      assert.equal(client.listenerCount("error"), idleBaseline);
      server = startHealthServer(0, { ready: () => postgresAndRedisReady(pool, redis.url) });
      if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      assert.equal((await fetch(`${base}/ready`)).status, 200);
      execFileSync("docker", ["pause", pg.container.getId()]);
      paused = true;
      const hangs = [];
      for (let i = 0; i < 3; i++) {
        const started = Date.now();
        assert.equal(await postgresAndRedisReady(pool, redis.url), false);
        hangs.push(Date.now() - started);
        assert.ok(hangs.at(-1) < READINESS_DEADLINE_MS + 750);
        // pg-pool installs its fixed idle observer even when release(true)
        // destroys a connection. The temporary readiness handler is gone.
        assert.deepEqual(client.listeners("error"), idleListeners);
      }
      assert.equal((await fetch(`${base}/health`)).status, 200);
      const pausedReady = await fetch(`${base}/ready`);
      assert.equal(pausedReady.status, 503);
      assert.deepEqual(await pausedReady.json(), { status: "not-ready" });
      execFileSync("docker", ["unpause", pg.container.getId()]);
      paused = false;
      assert.equal(await postgresAndRedisReady(pool, redis.url), true);
      let idleDeadline;
      const idleFailure = new Promise((resolve, reject) => {
        pool.once("error", resolve);
        idleDeadline = setTimeout(
          () => reject(new Error("Idle connection error was not observed")),
          1500,
        );
      });
      try {
        execFileSync("docker", ["stop", "--time", "1", pg.container.getId()]);
        await idleFailure;
      } finally {
        clearTimeout(idleDeadline);
      }
      assert.ok(idleErrors >= 1);
      for (let i = 0; i < 30; i++)
        assert.equal(await postgresAndRedisReady(pool, redis.url), false);
      assert.equal((await fetch(`${base}/health`)).status, 200);
      assert.equal((await fetch(`${base}/ready`)).status, 503);
      // A destroyed idle client may retain one fixed pg-pool observer; no probe handler.
      for (const checked of clients) assert.ok(checked.listenerCount("error") <= idleBaseline);
      assert.equal(pool.listenerCount("error"), 1);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(warnings.length, 0);
      console.log(
        "B2_READINESS_EVIDENCE",
        JSON.stringify({
          probes: 500,
          baseline,
          final,
          idleBaseline,
          warnings: warnings.length,
          downProbes: 30,
          hangsMs: hangs,
          idleErrors,
        }),
      );
    } finally {
      if (paused) execFileSync("docker", ["unpause", pg.container.getId()]);
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      await pool?.end();
      await Promise.allSettled([pg?.close(), redis?.close()]);
      process.removeListener("warning", capture);
    }
  },
);

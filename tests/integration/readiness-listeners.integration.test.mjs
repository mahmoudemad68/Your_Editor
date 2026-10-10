/** B2-01: real pooled-client reuse, dependency outages and HTTP readiness. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate, setTimeout, clearTimeout } from "node:timers";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { startPostgres, startRedis } from "./support/containers.mjs";
const require = createRequire(new URL("../../packages/job-queue/package.json", import.meta.url));
const { Pool } = require("pg");
const {
  postgresAndRedisReady,
  observePostgresPool,
  READINESS_DEADLINE_MS,
} = require("../../packages/job-queue/dist/index.js");
const { startHealthServer } = require("../../packages/shared/dist/index.js");
const execute = promisify(execFile);
const docker = (args) => execute("docker", args, { timeout: 10_000 });

test(
  "500 real readiness probes retain no client listeners; paused/killed PostgreSQL fails safely",
  { timeout: 120000 },
  async () => {
    const warnings = [];
    const capture = (warning) => {
      if (warning.name === "MaxListenersExceededWarning") warnings.push(warning);
    };
    process.on("warning", capture);
    let evidence;
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
      await docker(["pause", pg.container.getId()]);
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
      await docker(["unpause", pg.container.getId()]);
      paused = false;
      assert.equal(await postgresAndRedisReady(pool, redis.url), true);
      // Recovery can create a different connection. Check it out, exercise it,
      // and return it before arming the observer; pool errors concern idle clients.
      const idleClient = await pool.connect();
      try {
        await idleClient.query("SELECT 1");
      } finally {
        idleClient.release();
      }
      const idlePool = {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      };
      assert.deepEqual(idlePool, { total: 1, idle: 1, waiting: 0 });
      assert.equal(idleClient.listenerCount("error"), idleBaseline);
      let idleDeadline;
      let onIdleError;
      let idleErrorMs;
      const injectionStarted = performance.now();
      const idleFailure = new Promise((resolve, reject) => {
        onIdleError = (error, disconnected) => {
          idleErrorMs = performance.now() - injectionStarted;
          resolve({ error, disconnected });
        };
        pool.once("error", onIdleError);
        idleDeadline = setTimeout(
          () => reject(new Error("Idle connection error was not observed")),
          1500,
        );
      });
      // Unexpected process death must break the idle TCP connection. Unlike
      // synchronous graceful stop, this leaves Node free to observe its error
      // while Docker is still handling shutdown. Keep the original watchdog.
      const killed = docker(["kill", "--signal=KILL", pg.container.getId()]);
      try {
        const [, observed] = await Promise.all([killed, idleFailure]);
        assert.ok(observed.error instanceof Error);
        assert.equal(observed.disconnected, idleClient);
      } finally {
        clearTimeout(idleDeadline);
        pool.removeListener("error", onIdleError);
        // Do not race teardown against an outstanding Docker command on failure.
        await killed.catch(() => undefined);
      }
      assert.ok(idleErrors >= 1);
      assert.equal(pool.listenerCount("error"), 1);
      const failureProbeStarted = performance.now();
      assert.equal(await postgresAndRedisReady(pool, redis.url), false);
      const failureProbeMs = performance.now() - failureProbeStarted;
      assert.ok(failureProbeMs < READINESS_DEADLINE_MS + 750);
      for (let i = 0; i < 30; i++)
        assert.equal(await postgresAndRedisReady(pool, redis.url), false);
      assert.equal((await fetch(`${base}/health`)).status, 200);
      const killedReady = await fetch(`${base}/ready`);
      assert.equal(killedReady.status, 503);
      assert.deepEqual(await killedReady.json(), { status: "not-ready" });
      // A destroyed idle client may retain one fixed pg-pool observer; no probe handler.
      for (const checked of clients) assert.ok(checked.listenerCount("error") <= idleBaseline);
      assert.equal(pool.listenerCount("error"), 1);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(warnings.length, 0);
      evidence = {
        probes: 500,
        baseline,
        final,
        idleBaseline,
        warnings: warnings.length,
        downProbes: 30,
        hangsMs: hangs,
        idleErrors,
        idlePool,
        idleErrorMs,
        failureProbeMs,
        poolErrorListeners: pool.listenerCount("error"),
        clientErrorListeners: clients.map((checked) => checked.listenerCount("error")),
        healthAfterFailure: 200,
        readyAfterFailure: 503,
      };
    } finally {
      try {
        const cleanup = await Promise.allSettled([
          (async () => {
            if (server) {
              server.closeAllConnections();
              await new Promise((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
              );
            }
          })(),
          pool?.end(),
          (async () => {
            try {
              if (paused) await docker(["unpause", pg.container.getId()]);
            } finally {
              await pg?.close();
            }
          })(),
          redis?.close(),
        ]);
        const failures = cleanup.filter((result) => result.status === "rejected");
        assert.deepEqual(failures, [], "Readiness cleanup failed");
        // Assert removal of this test's resources, including the killed container.
        const { stdout } = await docker(["ps", "--all", "--quiet", "--no-trunc"]);
        const remaining = stdout.trim().split(/\s+/);
        for (const resource of [pg, redis])
          if (resource) assert.ok(!remaining.includes(resource.container.getId()));
      } finally {
        process.removeListener("warning", capture);
      }
    }
    console.log("B2_READINESS_EVIDENCE", JSON.stringify({ ...evidence, leakedResources: 0 }));
  },
);

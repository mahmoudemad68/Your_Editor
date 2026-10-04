/**
 * /ready must fail within one second when Postgres or Redis never answers.
 * These containers belong to the test. The shared development services stay up.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { after, test } from "node:test";

const root = path.resolve(".");
const require = createRequire(path.join(root, "workers/media-worker/package.json"));
const { Pool } = require("pg");
const { READINESS_DEADLINE_MS, observePostgresPool, postgresAndRedisReady } = require(
  path.join(root, "packages/job-queue/dist/index.js"),
);
const { startHealthServer } = require(path.join(root, "packages/shared/dist/index.js"));

const suffix = `${process.pid}-${Date.now().toString(36)}`;
const postgresName = `editagent-ready-pg-${suffix}`;
const redisName = `editagent-ready-redis-${suffix}`;
const postgresPort = 55432;
const redisPort = 56379;

after(() => {
  restoreContainer(postgresName);
  restoreContainer(redisName);
});

test("paused and stopped dependencies make /ready return 503", { timeout: 120_000 }, async () => {
  docker([
    "run",
    "-d",
    "--name",
    postgresName,
    "--network",
    "host",
    "-e",
    "POSTGRES_USER=editagent",
    "-e",
    "POSTGRES_PASSWORD=editagent-dev-password",
    "-e",
    "POSTGRES_DB=editagent",
    "postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea",
    "-c",
    `port=${postgresPort}`,
  ]);
  docker([
    "run",
    "-d",
    "--name",
    redisName,
    "--network",
    "host",
    "redis:7.4-alpine",
    "--port",
    String(redisPort),
  ]);
  const databaseUrl = `postgresql://editagent:editagent-dev-password@127.0.0.1:${postgresPort}/editagent`;
  const redisUrl = `redis://127.0.0.1:${redisPort}/0`;
  await waitFor(
    () =>
      spawnSync("docker", [
        "exec",
        postgresName,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-p",
        String(postgresPort),
        "-U",
        "editagent",
      ]).status === 0,
    "postgres",
  );
  await waitFor(
    () =>
      spawnSync("docker", ["exec", redisName, "redis-cli", "-p", String(redisPort), "ping"])
        .stdout?.toString()
        .includes("PONG") === true,
    "redis",
  );

  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: READINESS_DEADLINE_MS,
  });
  observePostgresPool(pool, () => undefined);
  const server = startHealthServer(0, {
    ready: () => postgresAndRedisReady(pool, redisUrl),
  });
  try {
    await listening(server);
    const base = baseUrl(server);
    await waitFor(() => postgresAndRedisReady(pool, redisUrl), "host dependencies");
    await expectStatus(base, "/health", 200, { status: "ok" });
    await expectStatus(base, "/ready", 200, { status: "ready" });
    const healthyPython = pythonProbe(databaseUrl, redisUrl);
    assert.equal(healthyPython.ready, true);
    assert.ok(
      healthyPython.elapsedMs < 5_000,
      `healthy python probe took ${healthyPython.elapsedMs}ms`,
    );

    docker(["pause", postgresName]);
    docker(["pause", redisName]);
    await expectStatus(base, "/health", 200, { status: "ok" });
    await expectStatus(base, "/ready", 503, { status: "not-ready" }, READINESS_DEADLINE_MS + 1_500);
    const pausedDirect = await timed(() => postgresAndRedisReady(pool, redisUrl));
    assert.equal(pausedDirect.value, false);
    assert.ok(
      pausedDirect.elapsedMs < READINESS_DEADLINE_MS + 1_500,
      `paused probe took ${pausedDirect.elapsedMs}ms`,
    );
    const pausedPython = pythonProbe(databaseUrl, redisUrl);
    assert.equal(pausedPython.ready, false);
    assert.ok(
      pausedPython.elapsedMs < 3_000,
      `paused python probe took ${pausedPython.elapsedMs}ms`,
    );

    docker(["unpause", postgresName]);
    docker(["unpause", redisName]);
    await waitFor(
      () =>
        spawnSync("docker", [
          "exec",
          postgresName,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-p",
          String(postgresPort),
          "-U",
          "editagent",
        ]).status === 0,
      "postgres after unpause",
    );
    await waitFor(
      () =>
        spawnSync("docker", ["exec", redisName, "redis-cli", "-p", String(redisPort), "ping"])
          .stdout?.toString()
          .includes("PONG") === true,
      "redis after unpause",
    );
    await expectReadyAgain(base, databaseUrl, redisUrl);
    assert.equal(pythonProbe(databaseUrl, redisUrl).ready, true);

    docker(["stop", postgresName]);
    docker(["stop", redisName]);
    await expectStatus(base, "/health", 200, { status: "ok" });
    await expectStatus(base, "/ready", 503, { status: "not-ready" }, READINESS_DEADLINE_MS + 1_500);
    const stoppedPython = pythonProbe(databaseUrl, redisUrl);
    assert.equal(stoppedPython.ready, false);
    assert.ok(
      stoppedPython.elapsedMs < 3_000,
      `stopped python probe took ${stoppedPython.elapsedMs}ms`,
    );

    docker(["start", postgresName]);
    docker(["start", redisName]);
    await waitFor(
      () =>
        spawnSync("docker", [
          "exec",
          postgresName,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-p",
          String(postgresPort),
          "-U",
          "editagent",
        ]).status === 0,
      "postgres after start",
    );
    await waitFor(
      () =>
        spawnSync("docker", ["exec", redisName, "redis-cli", "-p", String(redisPort), "ping"])
          .stdout?.toString()
          .includes("PONG") === true,
      "redis after start",
    );
    await waitFor(() => hostReady(databaseUrl, redisUrl), "host ports after start");
    await expectStatus(base, "/health", 200, { status: "ok" });
    await expectReadyAgain(base, databaseUrl, redisUrl);
    assert.equal(pythonProbe(databaseUrl, redisUrl).ready, true);
  } finally {
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
    await pool.end();
    restoreContainer(postgresName);
    restoreContainer(redisName);
  }
});

function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `docker ${args.join(" ")} failed`);
  }
  return (result.stdout || "").trim();
}

function restoreContainer(name) {
  spawnSync("docker", ["unpause", name], { encoding: "utf8" });
  spawnSync("docker", ["start", name], { encoding: "utf8" });
  spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" });
}

async function waitFor(ready, label) {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    if (await ready()) {
      return;
    }
    await delay(200);
  }
  throw new Error(`${label} did not become ready`);
}

function listening(server) {
  if (server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
}

function baseUrl(server) {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function expectReadyAgain(base, databaseUrl, redisUrl) {
  const started = Date.now();
  let status = 0;
  while (Date.now() - started < 10_000) {
    const response = await fetch(`${base}/ready`);
    status = response.status;
    if (status === 200) {
      assert.deepEqual(await response.json(), { status: "ready" });
      return;
    }
    await response.arrayBuffer();
    await delay(200);
  }
  assert.equal(status, 200, await diagnose(databaseUrl, redisUrl));
}

async function hostReady(databaseUrl, redisUrl) {
  const detail = await diagnose(databaseUrl, redisUrl);
  return detail === "postgres=ok redis=PONG";
}

async function diagnose(databaseUrl, redisUrl) {
  const { Client } = require("pg");
  const { Redis } = createRequire(path.join(root, "packages/job-queue/package.json"))("ioredis");
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 1_000 });
  let postgres = "ok";
  try {
    await client.connect();
    await client.query("SELECT 1");
  } catch (error) {
    postgres = error instanceof Error ? error.message : String(error);
  } finally {
    await client.end().catch(() => undefined);
  }
  const redis = new Redis(redisUrl, {
    connectTimeout: 1_000,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  redis.on("error", () => undefined);
  let redisMessage;
  try {
    await redis.connect();
    redisMessage = await redis.ping();
  } catch (error) {
    redisMessage = error instanceof Error ? error.message : String(error);
  } finally {
    redis.disconnect();
  }
  return `postgres=${postgres} redis=${redisMessage}`;
}

async function expectStatus(base, pathName, status, body, maxMs) {
  const started = Date.now();
  const response = await fetch(`${base}${pathName}`);
  const elapsed = Date.now() - started;
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), body);
  if (maxMs !== undefined) {
    assert.ok(elapsed < maxMs, `${pathName} took ${elapsed}ms`);
  }
}

async function timed(work) {
  const started = Date.now();
  const value = await work();
  return { value, elapsedMs: Date.now() - started };
}

function pythonProbe(databaseUrl, redisUrl) {
  const script = [
    "import os, time",
    "from editagent_ai_worker.infrastructure.readiness import dependencies_ready",
    "started = time.monotonic()",
    'result = dependencies_ready(os.environ["READY_DATABASE_URL"], os.environ["READY_REDIS_URL"])',
    'print(f"{str(result).lower()} {time.monotonic() - started:.3f}")',
  ].join("\n");
  const result = spawnSync(
    "uv",
    ["run", "--project", path.join(root, "workers/ai-worker"), "python", "-c", script],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        READY_DATABASE_URL: databaseUrl,
        READY_REDIS_URL: redisUrl,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "python readiness probe failed");
  }
  const [flag, seconds] = result.stdout.trim().split(/\s+/);
  return { ready: flag === "true", elapsedMs: Number(seconds) * 1000 };
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

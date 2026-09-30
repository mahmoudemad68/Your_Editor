import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { ConfigurationError, loadAgentWorkerConfig } from "./config.js";

const databaseUrl = "postgresql://editagent:editagent-dev-password@postgres:5432/editagent";
const redisUrl = "redis://redis:6379/0";

test("agent-worker configuration fails when DATABASE_URL is missing", () => {
  assert.throws(
    () => loadAgentWorkerConfig({ REDIS_URL: redisUrl }),
    (error: unknown) => {
      if (!(error instanceof ConfigurationError)) {
        return false;
      }
      assert.match(error.message, /Agent worker configuration error/);
      assert.match(error.message, /DATABASE_URL is required/);
      return true;
    },
  );
});

test("agent-worker configuration fails when REDIS_URL is invalid", () => {
  assert.throws(
    () => loadAgentWorkerConfig({ DATABASE_URL: databaseUrl, REDIS_URL: "http://redis:6379" }),
    /REDIS_URL/,
  );
});

test("the agent-worker process exits when DATABASE_URL is absent", () => {
  const packageRoot = path.resolve(__dirname, "..", "..");
  const result = spawnSync(process.execPath, ["dist/index.js"], {
    cwd: packageRoot,
    env: { PATH: process.env["PATH"] ?? "", REDIS_URL: redisUrl },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr ?? "", /DATABASE_URL is required/);
});

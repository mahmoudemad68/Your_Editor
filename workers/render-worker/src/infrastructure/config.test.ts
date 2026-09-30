import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { ConfigurationError, loadRenderWorkerConfig } from "./config.js";

const redisUrl = "redis://redis:6379/0";

test("render-worker configuration fails when DATABASE_URL is missing", () => {
  assert.throws(
    () => loadRenderWorkerConfig({ REDIS_URL: redisUrl }),
    (error: unknown) => {
      if (!(error instanceof ConfigurationError)) {
        return false;
      }
      assert.match(error.message, /Render worker configuration error/);
      assert.match(error.message, /DATABASE_URL is required/);
      return true;
    },
  );
});

test("the render-worker process exits when DATABASE_URL is absent", () => {
  const packageRoot = path.resolve(__dirname, "..", "..");
  const result = spawnSync(process.execPath, ["dist/index.js"], {
    cwd: packageRoot,
    env: {
      PATH: process.env["PATH"] ?? "",
      REDIS_URL: redisUrl,
      S3_ENDPOINT: "http://minio:9000",
      S3_BUCKET: "editagent",
      S3_ACCESS_KEY_ID: "editagent",
      S3_SECRET_ACCESS_KEY: "editagent-dev-secret",
      S3_REGION: "us-east-1",
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr ?? "", /DATABASE_URL is required/);
});

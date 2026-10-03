import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { ConfigurationError, loadApiConfig } from "./config.js";

const databaseUrl = "postgresql://editagent:editagent-dev-password@postgres:5432/editagent";

const apiEnv = {
  DATABASE_URL: databaseUrl,
  REDIS_URL: "redis://redis:6379/0",
  S3_ENDPOINT: "http://minio:9000",
  S3_PUBLIC_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "editagent",
  S3_ACCESS_KEY_ID: "editagent",
  S3_SECRET_ACCESS_KEY: "editagent-dev-secret",
  S3_REGION: "us-east-1",
};

test("the API configuration boundary rejects a missing database URL", () => {
  assert.throws(
    () => loadApiConfig({}),
    (error: unknown) => {
      if (!(error instanceof ConfigurationError)) {
        return false;
      }
      assert.equal(error.processName, "API");
      assert.match(error.message, /API configuration error/);
      assert.match(error.message, /DATABASE_URL is required/);
      assert.match(error.message, /postgresql:\/\//);
      return true;
    },
  );
});

test("the API configuration boundary rejects an invalid database URL", () => {
  assert.throws(() => loadApiConfig({ ...apiEnv, DATABASE_URL: "not-a-url" }), /DATABASE_URL/);
});

test("the API process exits immediately when DATABASE_URL is absent", () => {
  const packageRoot = path.resolve(__dirname, "..", "..");
  const started = Date.now();
  const result = spawnSync(process.execPath, ["dist/main.js"], {
    cwd: packageRoot,
    env: { PATH: process.env["PATH"] ?? "" },
    encoding: "utf8",
    timeout: 10_000,
  });
  const elapsed = Date.now() - started;

  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.ok(elapsed < 10_000, `startup took ${elapsed}ms`);
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  assert.match(output, /API configuration error/);
  assert.match(output, /DATABASE_URL is required/);
  assert.doesNotMatch(output, /Nest application successfully started/);
});

test("a present database URL is returned unchanged", () => {
  const config = loadApiConfig(apiEnv);
  assert.equal(config.databaseUrl, databaseUrl);
  assert.equal(config.redisUrl, "redis://redis:6379/0");
  assert.equal(config.mediaInspectQueue, "media");
  assert.equal(config.objectStorage.endpoint, "http://minio:9000");
  assert.equal(config.objectStorage.publicEndpoint, "http://localhost:9000");
  assert.equal(config.objectStorage.presignTtlSeconds, 900);
});

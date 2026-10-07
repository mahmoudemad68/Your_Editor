import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { ConfigurationError, loadMediaWorkerConfig } from "./config.js";

const databaseUrl = "postgresql://editagent:editagent-dev-password@postgres:5432/editagent";
const redisUrl = "redis://redis:6379/0";

test("media-worker configuration fails when DATABASE_URL is missing", () => {
  assert.throws(
    () => loadMediaWorkerConfig({ REDIS_URL: redisUrl }),
    (error: unknown) => {
      if (!(error instanceof ConfigurationError)) {
        return false;
      }
      assert.match(error.message, /Media worker configuration error/);
      assert.match(error.message, /DATABASE_URL is required/);
      return true;
    },
  );
});

test("the media-worker process exits when DATABASE_URL is absent", () => {
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

test("media-worker configuration accepts a complete development environment", () => {
  const config = loadMediaWorkerConfig({
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    S3_ENDPOINT: "http://minio:9000",
    S3_BUCKET: "editagent",
    S3_ACCESS_KEY_ID: "editagent",
    S3_SECRET_ACCESS_KEY: "editagent-dev-secret",
    S3_REGION: "us-east-1",
  });
  assert.equal(config.databaseUrl, databaseUrl);
  assert.equal(config.objectStorage.bucket, "editagent");
  assert.equal(config.ffprobePath, "ffprobe");
  assert.equal(config.ffmpegPath, "ffmpeg");
  assert.equal(config.validationPolicy.maxDurationSeconds, 1800);
  assert.equal(config.ffprobeTimeoutMs, 30_000);
  assert.equal(config.probeTmpDir, null);
  assert.equal(config.mediaInspectQueue, "media");
  assert.equal(config.healthPort, 3200);
  const configured = loadMediaWorkerConfig({
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    S3_ENDPOINT: "http://minio:9000",
    S3_BUCKET: "editagent",
    S3_ACCESS_KEY_ID: "editagent",
    S3_SECRET_ACCESS_KEY: "editagent-dev-secret",
    S3_REGION: "us-east-1",
    FFPROBE_PATH: "/usr/bin/ffprobe",
    FFPROBE_TIMEOUT_MS: "15000",
    PROBE_TMPDIR: "/tmp/editagent-probe",
  });
  assert.equal(configured.ffprobePath, "/usr/bin/ffprobe");
  assert.equal(configured.ffprobeTimeoutMs, 15_000);
  assert.equal(configured.probeTmpDir, "/tmp/editagent-probe");
  assert.throws(
    () =>
      loadMediaWorkerConfig({
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        S3_ENDPOINT: "http://minio:9000",
        S3_BUCKET: "editagent",
        S3_ACCESS_KEY_ID: "editagent",
        S3_SECRET_ACCESS_KEY: "editagent-dev-secret",
        S3_REGION: "us-east-1",
        FFPROBE_TIMEOUT_MS: "0",
      }),
    ConfigurationError,
  );
  assert.throws(
    () =>
      loadMediaWorkerConfig({
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        S3_ENDPOINT: "http://minio:9000",
        S3_BUCKET: "editagent",
        S3_ACCESS_KEY_ID: "editagent",
        S3_SECRET_ACCESS_KEY: "editagent-dev-secret",
        S3_REGION: "us-east-1",
        PROBE_TMPDIR: "relative",
      }),
    /absolute path/,
  );
});

test("US-127 removes the production unvalidated-derivation bypass", () => {
  assert.throws(
    () =>
      loadMediaWorkerConfig({
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        S3_ENDPOINT: "http://storage:9000",
        S3_BUCKET: "editagent",
        S3_ACCESS_KEY_ID: "editagent",
        S3_SECRET_ACCESS_KEY: "development",
        S3_REGION: "us-east-1",
        ALLOW_UNVALIDATED_DERIVATION: "true",
      }),
    /no longer permitted/,
  );
});

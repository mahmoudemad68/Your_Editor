import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConfigurationError,
  parseAgentWorkerConfig,
  parseApiConfig,
  parseMediaWorkerConfig,
  parseRenderWorkerConfig,
  parseWebConfig,
} from "./config.js";

const databaseUrl = "postgresql://editagent:editagent-dev-password@postgres:5432/editagent";
const redisUrl = "redis://redis:6379/0";

const storageEnv = {
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  S3_ENDPOINT: "http://minio:9000",
  S3_BUCKET: "editagent",
  S3_ACCESS_KEY_ID: "editagent",
  S3_SECRET_ACCESS_KEY: "editagent-dev-secret",
  S3_REGION: "us-east-1",
};

const apiStorageEnv = {
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  S3_ENDPOINT: "http://minio:9000",
  S3_PUBLIC_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "editagent",
  S3_ACCESS_KEY_ID: "editagent",
  S3_SECRET_ACCESS_KEY: "editagent-dev-secret",
  S3_REGION: "us-east-1",
};

function assertConfigError(run: () => unknown, field: string): void {
  assert.throws(run, (error: unknown) => {
    if (!(error instanceof ConfigurationError)) {
      return false;
    }
    assert.match(error.message, /configuration error/i);
    assert.match(error.message, new RegExp(field));
    return true;
  });
}

test("API config fails when DATABASE_URL is missing", () => {
  assertConfigError(() => parseApiConfig({}), "DATABASE_URL");
});

test("API config fails when DATABASE_URL is empty", () => {
  assertConfigError(() => parseApiConfig({ DATABASE_URL: "" }), "DATABASE_URL");
});

test("API config fails when DATABASE_URL is not a postgres URL", () => {
  assertConfigError(
    () => parseApiConfig({ DATABASE_URL: "http://postgres:5432/editagent" }),
    "DATABASE_URL",
  );
});

test("API config fails when PORT is not a port number", () => {
  assertConfigError(() => parseApiConfig({ ...apiStorageEnv, PORT: "0" }), "PORT");
  assertConfigError(() => parseApiConfig({ ...apiStorageEnv, PORT: "nope" }), "PORT");
});

test("API config parses a database URL and applies port and host defaults", () => {
  const config = parseApiConfig({ ...apiStorageEnv, PATH: "/usr/bin" });
  assert.equal(config.databaseUrl, databaseUrl);
  assert.equal(config.redisUrl, redisUrl);
  assert.equal(config.port, 3001);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.objectStorage.endpoint, "http://minio:9000");
  assert.equal(config.objectStorage.publicEndpoint, "http://localhost:9000");
  assert.equal(config.objectStorage.presignTtlSeconds, 900);
});

test("API config accepts an explicit port and host", () => {
  const config = parseApiConfig({ ...apiStorageEnv, PORT: "3001", HOST: "127.0.0.1" });
  assert.equal(config.port, 3001);
  assert.equal(config.host, "127.0.0.1");
});

test("API config rejects a missing public object-storage endpoint and a bad presign TTL", () => {
  const { S3_PUBLIC_ENDPOINT: _ignored, ...withoutPublic } = apiStorageEnv;
  assertConfigError(() => parseApiConfig(withoutPublic), "S3_PUBLIC_ENDPOINT");
  assertConfigError(
    () => parseApiConfig({ ...apiStorageEnv, S3_PRESIGN_TTL_SECONDS: "0" }),
    "S3_PRESIGN_TTL_SECONDS",
  );
  assertConfigError(
    () => parseApiConfig({ ...apiStorageEnv, S3_PRESIGN_TTL_SECONDS: "59" }),
    "S3_PRESIGN_TTL_SECONDS",
  );
});

test("Web config fails when API_BASE_URL is missing or not http", () => {
  assertConfigError(() => parseWebConfig({}), "API_BASE_URL");
  assertConfigError(
    () => parseWebConfig({ API_BASE_URL: "postgres://api:5432/editagent" }),
    "API_BASE_URL",
  );
});

test("Web config parses the API base URL", () => {
  const config = parseWebConfig({ API_BASE_URL: "http://api:3001" });
  assert.equal(config.apiBaseUrl, "http://api:3001");
  assert.equal(config.port, 3000);
});

test("Agent worker config fails when DATABASE_URL or REDIS_URL is missing or invalid", () => {
  assertConfigError(() => parseAgentWorkerConfig({ REDIS_URL: redisUrl }), "DATABASE_URL");
  assertConfigError(() => parseAgentWorkerConfig({ DATABASE_URL: databaseUrl }), "REDIS_URL");
  assertConfigError(
    () => parseAgentWorkerConfig({ DATABASE_URL: databaseUrl, REDIS_URL: "http://redis:6379" }),
    "REDIS_URL",
  );
});

test("Agent worker config allows an omitted provider secret and rejects an empty one", () => {
  const config = parseAgentWorkerConfig({ DATABASE_URL: databaseUrl, REDIS_URL: redisUrl });
  assert.equal(config.databaseUrl, databaseUrl);
  assert.equal(config.redisUrl, redisUrl);
  assert.equal(config.llmApiKey, undefined);
  assertConfigError(
    () =>
      parseAgentWorkerConfig({ DATABASE_URL: databaseUrl, REDIS_URL: redisUrl, LLM_API_KEY: "  " }),
    "LLM_API_KEY",
  );
});

test("Agent worker config keeps optional provider settings when they are valid", () => {
  const config = parseAgentWorkerConfig({
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    LLM_API_KEY: "dev-placeholder",
    LLM_BASE_URL: "http://ollama:11434",
    LLM_PROVIDER: "ollama",
  });
  assert.equal(config.llmApiKey, "dev-placeholder");
  assert.equal(config.llmBaseUrl, "http://ollama:11434");
  assert.equal(config.llmProvider, "ollama");
});

test("Media and render worker config fail when object storage settings are missing", () => {
  assertConfigError(
    () => parseMediaWorkerConfig({ DATABASE_URL: databaseUrl, REDIS_URL: redisUrl }),
    "S3_ENDPOINT",
  );
  const { S3_BUCKET: _bucket, ...withoutBucket } = storageEnv;
  assertConfigError(() => parseRenderWorkerConfig(withoutBucket), "S3_BUCKET");
});

test("Media worker config parses platform connection settings", () => {
  const config = parseMediaWorkerConfig(storageEnv);
  assert.equal(config.objectStorage.endpoint, "http://minio:9000");
  assert.equal(config.objectStorage.bucket, "editagent");
  assert.equal(config.objectStorage.accessKeyId, "editagent");
  assert.equal(config.objectStorage.region, "us-east-1");
});

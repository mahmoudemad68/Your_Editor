import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigurationError, loadWebConfig } from "./config";

test("web configuration fails when API_BASE_URL is missing", () => {
  assert.throws(
    () => loadWebConfig({}),
    (error: unknown) => {
      if (!(error instanceof ConfigurationError)) {
        return false;
      }
      assert.match(error.message, /Web configuration error/);
      assert.match(error.message, /API_BASE_URL is required/);
      return true;
    },
  );
});

test("web configuration rejects an invalid API base URL", () => {
  assert.throws(() => loadWebConfig({ API_BASE_URL: "not-a-url" }), /API_BASE_URL/);
});

test("web configuration does not read a database URL", () => {
  const config = loadWebConfig({
    API_BASE_URL: "http://api:3001",
    DATABASE_URL: "postgresql://editagent:editagent-dev-password@postgres:5432/editagent",
  });
  assert.equal(config.apiBaseUrl, "http://api:3001");
  assert.equal("databaseUrl" in config, false);
});

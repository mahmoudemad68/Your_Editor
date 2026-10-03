/**
 * OIDC and LDAP must not start through environment, config files, or
 * persisted MinIO configuration. The check does not patch the binary.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const script = path.resolve(import.meta.dirname, "../../infra/minio/reject-vulnerable-identity.sh");

function run(extra = {}) {
  const data = mkdtempSync(path.join(tmpdir(), "editagent-minio-data-"));
  return spawnSync("sh", [script], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      MINIO_DATA_DIR: data,
      ...extra,
    },
  });
}

test("a config file activates OpenID when the process environment does not", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "editagent-minio-env-"));
  const file = path.join(directory, "minio.env");
  writeFileSync(
    file,
    "export MINIO_IDENTITY_OPENID_CONFIG_URL=https://idp.example.test/.well-known/openid-configuration\n",
  );
  const blocked = run({ MINIO_CONFIG_ENV_FILE: file });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /MINIO_IDENTITY_OPENID_CONFIG_URL/);
  assert.match(blocked.stderr, /still contains those vulnerabilities/);
});

test("persisted LDAP server settings are rejected", () => {
  const data = mkdtempSync(path.join(tmpdir(), "editagent-minio-persist-"));
  const configDir = path.join(data, ".minio.sys/config/config.json");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, "xl.meta"),
    '{"identity_ldap":{"_":[{"key":"server_addr","value":"ldap.example.test:389"}]}}',
  );
  const blocked = spawnSync("sh", [script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, MINIO_DATA_DIR: data },
  });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /persisted OIDC or LDAP/);
});

test("empty default identity records and a comment-only file are allowed", () => {
  const data = mkdtempSync(path.join(tmpdir(), "editagent-minio-empty-"));
  mkdirSync(path.join(data, ".minio.sys/config/config.json"), { recursive: true });
  writeFileSync(
    path.join(data, ".minio.sys/config/config.json/xl.meta"),
    '{"api":{"_":[{"key":"root_access","value":"on"}]},"identity_openid":{"_":[{"key":"enable","value":""},{"key":"config_url","value":""}]},"identity_ldap":{"_":[{"key":"server_addr","value":""}]}}',
  );
  const file = path.join(data, "comments.env");
  writeFileSync(file, "# MINIO_IDENTITY_OPENID_CONFIG_URL is not set\n");
  const allowed = spawnSync("sh", [script], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      MINIO_DATA_DIR: data,
      MINIO_CONFIG_ENV_FILE: file,
    },
  });
  assert.equal(allowed.status, 0, allowed.stderr);
});

/**
 * US-113 gates that can run without a staging host.
 * A green local result is not a remote staging deployment.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { assertDigestPinned } from "../../infra/scripts/image-digest.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const digest = `ghcr.io/example/editagent-api@sha256:${"a".repeat(64)}`;

function stagingEnv() {
  const pinned = (name) => `ghcr.io/example/${name}@sha256:${"ab".repeat(32)}`;
  return {
    ...process.env,
    POSTGRES_USER: "editagent",
    POSTGRES_PASSWORD: "staging-config-test-password",
    POSTGRES_DB: "editagent",
    MINIO_ROOT_USER: "editagent",
    MINIO_ROOT_PASSWORD: "staging-config-test-secret",
    S3_ACCESS_KEY_ID: "staging-config-test-key",
    S3_SECRET_ACCESS_KEY: "staging-config-test-secret",
    S3_BUCKET: "editagent",
    S3_REGION: "us-east-1",
    S3_PUBLIC_ENDPOINT: "https://objects.example.test",
    MEDIA_INSPECT_QUEUE: "media",
    STAGING_BIND_IP: "127.0.0.1",
    STAGING_WEB_PORT: "3000",
    STAGING_OBJECTS_PORT: "8080",
    EDITAGENT_API_IMAGE: pinned("editagent-api"),
    EDITAGENT_WEB_IMAGE: pinned("editagent-web"),
    EDITAGENT_MEDIA_WORKER_IMAGE: pinned("editagent-media-worker"),
    EDITAGENT_RENDER_WORKER_IMAGE: pinned("editagent-render-worker"),
    EDITAGENT_AGENT_WORKER_IMAGE: pinned("editagent-agent-worker"),
    EDITAGENT_AI_WORKER_IMAGE: pinned("editagent-ai-worker"),
    EDITAGENT_MINIO_IMAGE: pinned("editagent-minio"),
    EDITAGENT_OBJECT_INGRESS_IMAGE: pinned("editagent-object-ingress"),
    EDITAGENT_POSTGRES_IMAGE: pinned("postgres"),
    EDITAGENT_REDIS_IMAGE: pinned("redis"),
  };
}

test("image references must be digest pinned", () => {
  assert.equal(assertDigestPinned("EDITAGENT_API_IMAGE", digest), undefined);
  assert.throws(() => assertDigestPinned("EDITAGENT_API_IMAGE", "editagent-api:local"), /sha256/);
  assert.throws(
    () =>
      assertDigestPinned("EDITAGENT_API_IMAGE", `editagent-api:latest@sha256:${"a".repeat(64)}`),
    /latest/,
  );
});

test("a synthetic secret fixture fails gitleaks and the repository does not", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "editagent-gitleaks-"));
  try {
    const synthetic = ["xoxb-123456789012", "-1234567890123", "-abcdefghijklmnopqrstuvwx"].join("");
    writeFileSync(path.join(directory, "fixture.env"), `slack=${synthetic}\n`);
    const leaked = spawnSync(
      "gitleaks",
      ["detect", "--no-git", "--source", directory, "--redact"],
      {
        encoding: "utf8",
      },
    );
    assert.equal(leaked.status, 1, leaked.stderr);
    const clean = spawnSync(
      "gitleaks",
      ["detect", "--source", root, "--redact", "--config", path.join(root, ".gitleaks.toml")],
      { encoding: "utf8" },
    );
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("staging compose has no credential fallbacks and does not publish MinIO", () => {
  const source = readFileSync(path.join(root, "compose.staging.yaml"), "utf8");
  assert.equal(source.includes(":-"), false);
  assert.equal(source.includes("editagent-dev-password"), false);
  assert.equal(source.includes("editagent-dev-secret"), false);
  assert.equal(source.includes("build:"), false);
  assert.match(source, /profiles: \["gpu"\]/);
  assert.match(source, /driver: nvidia/);

  const missing = spawnSync("docker", ["compose", "-f", "compose.staging.yaml", "config"], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.notEqual(missing.status, 0);

  const rendered = execFileSync("docker", ["compose", "-f", "compose.staging.yaml", "config"], {
    cwd: root,
    encoding: "utf8",
    env: stagingEnv(),
  });
  assert.equal(rendered.includes("editagent-dev-password"), false);
  assert.equal(rendered.includes(":latest"), false);
  assert.equal(rendered.includes(":local"), false);
  assert.equal(rendered.includes("ai-worker-gpu"), false);
  assert.equal(rendered.includes("cuda"), false);
  assert.match(rendered, /@sha256:/);
  assert.match(rendered, /host_ip: 127\.0\.0\.1/);
  const postgres =
    rendered.match(/\n {2}postgres:\n(?<body>[\s\S]*?)(?=\n {2}[^\s])/)?.groups?.body ?? "";
  assert.equal(postgres.includes("published:"), false);
  const redis =
    rendered.match(/\n {2}redis:\n(?<body>[\s\S]*?)(?=\n {2}[^\s])/)?.groups?.body ?? "";
  assert.equal(redis.includes("published:"), false);
  const minio =
    rendered.match(/\n {2}minio:\n(?<body>[\s\S]*?)(?=\n {2}[^\s])/)?.groups?.body ?? "";
  assert.equal(minio.includes("published:"), false);
  const ingress =
    rendered.match(/\n {2}object-ingress:\n(?<body>[\s\S]*?)(?=\n {2}[^\s])/)?.groups?.body ?? "";
  assert.match(ingress, /host_ip: 127\.0\.0\.1/);
});

test("staging smoke and readiness scripts refuse to invent a host", () => {
  const smoke = spawnSync("sh", [path.join(root, "infra/scripts/staging-smoke.sh")], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(smoke.status, 2);
  assert.match(smoke.stderr, /STAGING_API_URL/);
  const readiness = spawnSync(
    "sh",
    [path.join(root, "infra/scripts/staging-readiness-measure.sh")],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    },
  );
  assert.equal(readiness.status, 2);
  assert.match(readiness.stderr, /STAGING_API_URL/);
});

test("supply-chain workflow publishes digests and blocks an unconfigured staging host", () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/supply-chain.yml"), "utf8");
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const dependabot = readFileSync(path.join(root, ".github/dependabot.yml"), "utf8");
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /secrets\.GITHUB_TOKEN/);
  assert.match(workflow, /syft /);
  assert.match(workflow, /trivy image --severity CRITICAL --exit-code 1/);
  assert.match(workflow, /name: supply-chain-security/);
  assert.match(workflow, /needs: \[security-gate, images\]/);
  assert.match(workflow, /needs.publish.result == 'success'/);
  assert.equal(workflow.includes("docker push"), false);
  assert.match(workflow, /environment: staging/);
  assert.match(workflow, /STAGING_DEPLOYMENT_BLOCKED/);
  assert.equal(workflow.includes(":latest"), false);
  assert.match(ci, /gitleaks detect/);
  assert.match(ci, /pnpm audit --audit-level critical/);
  assert.match(dependabot, /interval: weekly/);
  assert.match(dependabot, /groups:/);
});

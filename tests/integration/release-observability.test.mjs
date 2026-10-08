import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("US-113 immutable release, publication guard, smoke and rollback dry runs", () => {
  execFileSync("python3", ["tests/integration/support/release-regressions.py"], {
    stdio: "inherit",
  });
});

test("PR/fork and dispatch cannot publish/deploy; main deployment requires Owner protection", () => {
  const source = readFileSync(".github/workflows/supply-chain.yml", "utf8");
  const publish = source.split("\n  publish:")[1].split("\n  release:")[0];
  const staging = source.split("\n  staging:")[1];
  assert.match(publish, /needs: \[dependencies, images, supply-chain-security\]/);
  for (const job of [publish, staging]) {
    assert.match(job, /if: github.event_name == 'push' && github.ref == 'refs\/heads\/main'/);
    assert.match(job, /contents: read/);
    assert.equal(job.includes("contents: write"), false);
  }
  assert.match(publish, /packages: write/);
  assert.equal(publish.includes("test-minio"), false);
  assert.match(staging, /STAGING_CD_ENABLED == 'true'/);
  assert.match(staging, /environment: staging/);
  assert.match(staging, /prevent_self_review/);
  assert.match(staging, /cancel-in-progress: false/);
  assert.match(staging, /packages: read/);
  assert.equal(staging.includes("packages: write"), false);
});

test("staging Compose uses immutable images and preserves current storage isolation", () => {
  const images = Object.fromEntries(
    [
      "API",
      "WEB",
      "MEDIA_WORKER",
      "RENDER_WORKER",
      "AGENT_WORKER",
      "AI_WORKER",
      "SEAWEEDFS",
      "POSTGRES",
      "REDIS",
    ].map((s) => [
      s + "_IMAGE",
      `ghcr.io/example/editor-${s.toLowerCase().replaceAll("_", "-")}@sha256:${"b".repeat(64)}`,
    ]),
  );
  const config = JSON.parse(
    execFileSync(
      "docker",
      ["compose", "-f", "compose.yaml", "-f", "compose.staging.yaml", "config", "--format", "json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...images,
          AUTH_TRUSTED_ORIGINS: "https://app.example.test",
          S3_PUBLIC_ENDPOINT: "https://objects.example.test",
        },
      },
    ),
  );
  for (const service of Object.values(config.services)) {
    assert.equal(service.build, undefined);
    assert.match(service.image, /@sha256:[a-f0-9]{64}$/);
  }
  for (const s of ["postgres", "redis", "api", "web", "seaweed-s3"])
    assert.equal(config.services[s].ports[0].host_ip, "127.0.0.1");
  assert.equal(config.networks.storage_internal.internal, true);
  assert.equal(config.services.api.environment.EDITAGENT_RUNTIME, "production");
  assert.equal(config.services.api.environment.AUTH_COOKIE_SECURE, "true");
  assert.equal(config.services["seaweed-volume"].restart, "no");
});

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createRequire } from "node:module";
const { load } = createRequire(import.meta.resolve("eslint"))("js-yaml");

function requireMediaQualification(workflow) {
  const { repository, "media-qualification": media, "real-asr": asr, ci } = workflow.jobs;
  assert.deepEqual(workflow.on, { pull_request: { branches: ["main"] } });
  assert.deepEqual(workflow.permissions, { actions: "write", contents: "read" });
  for (const job of [repository, media, asr]) {
    assert.equal(job["runs-on"], "ubuntu-24.04");
    assert.equal(job["timeout-minutes"], 45);
  }
  assert.deepEqual(media.permissions, { contents: "read" });
  assert.equal(media.if, undefined);
  assert.equal(media.needs, undefined);
  assert.deepEqual(media.env, repository.env);
  assert.deepEqual(media.services, repository.services);
  assert.equal(
    media.services.postgres.image,
    "postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea",
  );
  assert.equal(media.services.redis.image, "redis:7.4-alpine");
  assert.equal(media.steps[0].with.lfs, true);
  assert.equal(media.steps[0].with["persist-credentials"], false);
  assert.ok(media.steps.every((step) => !step["continue-on-error"]));
  const startup = media.steps.find((step) => step.name === "Start SeaweedFS").run;
  for (const guard of [
    "start-storage.sh",
    "verify-firewall-lifecycle.sh",
    "verify-jwt-authority.sh",
    "verify-trust-boundary.sh",
  ])
    assert.ok(startup.includes(`./infra/seaweedfs/${guard}`));
  for (const command of ["pnpm asr:container", "pnpm render:test --graduation-demo"]) {
    const steps = media.steps.filter((step) => step.run === command);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].if, "${{ !cancelled() }}");
    assert.ok(!repository.steps.some((step) => step.run === command));
  }
  assert.ok(media.steps.some((step) => step.run === "pnpm install --frozen-lockfile"));
  assert.ok(media.steps.some((step) => step.run === "pnpm build"));
  assert.ok(media.steps.some((step) => step.run?.includes("pnpm test:fixtures")));
  const audit = media.steps.find((step) => step.id === "graduation-audit");
  assert.ok(audit.run.includes("python3 tools/test/audit-artifacts.py"));
  const evidence = media.steps.find((step) => step.name === "Upload allowlisted test summary");
  assert.equal(evidence.if, "${{ !cancelled() && steps.graduation-audit.outcome == 'success' }}");
  assert.ok(evidence.with.path.includes(".local/graduation-demo-public/demo-export.mp4"));
  assert.ok(evidence.with.path.includes(".local/caption-public/repair-report.json"));
  assert.deepEqual(asr.strategy.matrix.shard, [
    "native",
    "languages",
    "state-single",
    "state-multi",
    "long-input",
    "alignment",
  ]);
  assert.equal(asr.strategy["fail-fast"], false);
  assert.deepEqual(ci.needs, ["repository", "real-asr", "media-qualification"]);
  assert.equal(ci.if, "${{ always() }}");
  assert.deepEqual(ci.steps[0].env, {
    REPOSITORY_RESULT: "${{ needs.repository.result }}",
    REAL_ASR_RESULT: "${{ needs['real-asr'].result }}",
    MEDIA_RESULT: "${{ needs['media-qualification'].result }}",
  });
  assert.deepEqual(ci.steps[0].run.trim().split("\n"), [
    'test "$REPOSITORY_RESULT" = success',
    'test "$REAL_ASR_RESULT" = success',
    'test "$MEDIA_RESULT" = success',
  ]);
}

test("bounded CI keeps independent real-media proofs required without extending deadlines", () => {
  requireMediaQualification(load(readFileSync(".github/workflows/ci.yml", "utf8")));
});

test("bounded CI rejects removed proofs, weakened guards and permission or deadline drift", () => {
  const original = load(readFileSync(".github/workflows/ci.yml", "utf8"));
  for (const mutate of [
    (w) => w.jobs.ci.needs.pop(),
    (w) => (w.jobs.ci.steps[0].run = 'test "$REAL_ASR_RESULT" = success\n'),
    (w) => (w.jobs["media-qualification"].if = "false"),
    (w) => (w.jobs["media-qualification"]["timeout-minutes"] = 46),
    (w) => (w.jobs["media-qualification"].permissions.actions = "write"),
    (w) => (w.jobs["media-qualification"].steps[0].with["persist-credentials"] = true),
    (w) => (w.jobs["media-qualification"].env.S3_ENDPOINT = "http://untrusted.test"),
    (w) => (w.jobs["media-qualification"].services.postgres.image = "postgres:latest"),
    (w) => w.jobs["real-asr"].strategy.matrix.shard.pop(),
    (w) => {
      const step = w.jobs["media-qualification"].steps.find((s) => s.run === "pnpm asr:container");
      step["continue-on-error"] = true;
    },
    (w) => {
      const step = w.jobs["media-qualification"].steps.find((s) =>
        s.run?.includes("--graduation-demo"),
      );
      step.run = "echo synthetic media success";
    },
    (w) => {
      const step = w.jobs["media-qualification"].steps.find((s) => s.name === "Start SeaweedFS");
      step.run = "./infra/seaweedfs/start-storage.sh";
    },
  ]) {
    const changed = globalThis.structuredClone(original);
    mutate(changed);
    assert.throws(() => requireMediaQualification(changed));
  }
});

test("bounded CI actual aggregate shell fails for every non-success prerequisite", () => {
  const workflow = load(readFileSync(".github/workflows/ci.yml", "utf8"));
  requireMediaQualification(workflow);
  const script = workflow.jobs.ci.steps[0].run;
  const shell = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
  const success = {
    REPOSITORY_RESULT: "success",
    REAL_ASR_RESULT: "success",
    MEDIA_RESULT: "success",
  };
  const execute = (results) => {
    const child = spawnSync(
      shell,
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
      {
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot ?? "", ...results },
        timeout: 5000,
        maxBuffer: 65536,
      },
    );
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    return child.status;
  };
  assert.equal(execute(success), 0);
  for (const key of Object.keys(success))
    for (const result of ["failure", "cancelled", "skipped", "", "SUCCESS"])
      assert.notEqual(execute({ ...success, [key]: result }), 0);
});

test("US-113 immutable release, publication guard, smoke and rollback dry runs", () => {
  execFileSync("python3", ["tests/integration/support/release-regressions.py"], {
    stdio: "inherit",
  });
});

test("PR/fork and dispatch cannot publish/deploy; main deployment requires Owner protection", () => {
  const workflow = load(readFileSync(".github/workflows/supply-chain.yml", "utf8"));
  const { publish, staging } = workflow.jobs;
  assert.deepEqual(publish.needs, [
    "release-authorization",
    "dependencies",
    "images",
    "supply-chain-security",
  ]);
  assert.deepEqual(staging.needs, ["release-authorization", "release"]);
  for (const job of [publish, staging]) {
    assert.match(job.if, /needs\.release-authorization\.result == 'success'/);
    assert.match(job.if, /needs\.release-authorization\.outputs\.authorized == '1'/);
    assert.match(job.if, /github.event_name == 'push' && github.ref == 'refs\/heads\/main'/);
    assert.equal(job.permissions.contents, "read");
  }
  assert.deepEqual(publish.permissions, { contents: "read", packages: "write" });
  assert.equal(publish.strategy.matrix.service.includes("test-minio"), false);
  assert.match(staging.if, /STAGING_CD_ENABLED == 'true'/);
  assert.match(staging.if, /needs\.release-authorization\.outputs\.staging_authorized == '1'/);
  assert.equal(staging.environment, "staging");
  assert.ok(staging.steps.some((step) => step.run?.includes("prevent_self_review")));
  assert.deepEqual(staging.concurrency, {
    group: "staging-deployment",
    "cancel-in-progress": false,
  });
  assert.deepEqual(staging.permissions, { contents: "read", actions: "read", packages: "read" });
});

test("staging Compose uses immutable images and preserves current storage isolation", () => {
  const images = Object.fromEntries(
    [
      "API",
      "WEB",
      "MEDIA_WORKER",
      "RENDER_WORKER",
      "RENDER_EXECUTOR",
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

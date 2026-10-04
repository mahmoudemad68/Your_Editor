/**
 * Regressions for the unresolved PR #18 review threads.
 * These checks do not contact a staging host.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
}

test("pip-audit reports accept both JSON shapes and real CVSS severity", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "editagent-osv-"));
  writeFileSync(
    path.join(fixture, "CVE-CRITICAL.json"),
    JSON.stringify({
      severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
    }),
  );
  writeFileSync(
    path.join(fixture, "CVE-HIGH.json"),
    JSON.stringify({
      severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:H/I:N/A:N" }],
    }),
  );
  const critical = mkdtempSync(path.join(tmpdir(), "editagent-audit-"));
  const criticalReport = path.join(critical, "report.json");
  writeFileSync(
    criticalReport,
    JSON.stringify([
      { name: "demo", version: "1", vulns: [{ id: "PYSEC-1", aliases: ["CVE-CRITICAL"] }] },
    ]),
  );
  const criticalResult = run(
    "python3",
    ["infra/scripts/python_audit_report.py", criticalReport, "1"],
    { env: { ...process.env, PYTHON_AUDIT_OSV_FIXTURE: fixture } },
  );
  assert.equal(criticalResult.status, 1, criticalResult.stdout);
  assert.match(criticalResult.stdout, /Critical Python vulnerabilities/);

  const highReport = path.join(critical, "high.json");
  writeFileSync(
    highReport,
    JSON.stringify({
      dependencies: [
        { name: "demo", version: "1", vulns: [{ id: "PYSEC-2", aliases: ["CVE-HIGH"] }] },
      ],
    }),
  );
  const highResult = run("python3", ["infra/scripts/python_audit_report.py", highReport, "1"], {
    env: { ...process.env, PYTHON_AUDIT_OSV_FIXTURE: fixture },
  });
  assert.equal(highResult.status, 0, highResult.stderr + highResult.stdout);
  assert.match(highResult.stdout, /non-critical/);
  assert.equal(highResult.stdout.includes("treated as critical"), false);
  rmSync(fixture, { recursive: true, force: true });
  rmSync(critical, { recursive: true, force: true });
});

test("staging env values with shell metacharacters round-trip through source", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "editagent-env-"));
  const file = path.join(directory, "staging.env");
  const secret = 'p@ss word # $HOME `id` "quoted" \\back';
  const result = run(
    "python3",
    ["infra/scripts/write-staging-env.py", file, "S3_SECRET_ACCESS_KEY"],
    {
      env: { ...process.env, S3_SECRET_ACCESS_KEY: secret },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const loaded = run("sh", ["-c", '. "$1"; printf %s "$S3_SECRET_ACCESS_KEY"', "sh", file]);
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(loaded.stdout, secret);
  rmSync(directory, { recursive: true, force: true });
});

test("replacing a deploy tree does not nest infra/infra", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "editagent-tree-"));
  const source = path.join(directory, "src");
  const destination = path.join(directory, "infra");
  mkdirSync(path.join(source, "scripts"), { recursive: true });
  writeFileSync(path.join(source, "scripts", "staging-deploy.sh"), "echo ok\n");
  mkdirSync(path.join(destination, "infra", "scripts"), { recursive: true });
  writeFileSync(path.join(destination, "infra", "scripts", "old.sh"), "echo stale\n");
  const result = run("sh", ["infra/scripts/replace-tree.sh", source, destination]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(path.join(destination, "scripts", "staging-deploy.sh"), "utf8"),
    "echo ok\n",
  );
  assert.equal(spawnSync("test", ["-e", path.join(destination, "infra")]).status, 1);
  rmSync(directory, { recursive: true, force: true });
});

test("silent readiness curl is bounded when the endpoint hangs", { timeout: 20_000 }, async () => {
  const fast = createServer((_request, response) => {
    response.writeHead(200);
    response.end("ok");
  });
  const hung = createServer(() => {});
  await new Promise((resolve) => fast.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => hung.listen(0, "127.0.0.1", resolve));
  const fastPort = fast.address().port;
  const hungPort = hung.address().port;
  const bin = mkdtempSync(path.join(tmpdir(), "editagent-docker-"));
  writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(path.join(bin, "log"))}
if printf '%s' "$*" | grep -q postgres; then
  echo 1
elif printf '%s' "$*" | grep -q redis; then
  printf 'connected_clients:1\\r\\n'
fi
exit 0
`,
  );
  chmodSync(path.join(bin, "docker"), 0o755);
  const started = Date.now();
  const result = await new Promise((resolve) => {
    const child = spawn("sh", ["infra/scripts/staging-readiness-measure.sh"], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        COMPOSE_FILE: "compose.staging.yaml",
        POSTGRES_USER: "editagent",
        POSTGRES_DB: "editagent",
        STAGING_API_URL: `http://127.0.0.1:${fastPort}`,
        STAGING_SILENT_API_URL: `http://127.0.0.1:${hungPort}`,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  const elapsed = Date.now() - started;
  fast.close();
  hung.close();
  rmSync(bin, { recursive: true, force: true });
  assert.notEqual(result.status, 0, result.stdout);
  assert.ok(elapsed < 12_000, `silent curl ran for ${elapsed}ms`);
});

test("smoke recovery restores redis when a later command fails", () => {
  const source = readFileSync(path.join(root, "infra/scripts/staging-smoke.sh"), "utf8");
  const begin = source.indexOf("# redis-restore-trap:begin");
  const end = source.indexOf("# redis-restore-trap:end");
  const stop = source.indexOf('docker compose -f "$COMPOSE_FILE" stop redis');
  assert.ok(begin >= 0 && end > begin && stop > end);
  const bin = mkdtempSync(path.join(tmpdir(), "editagent-redis-trap-"));
  const log = path.join(bin, "log");
  writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`,
  );
  chmodSync(path.join(bin, "docker"), 0o755);
  const script = `set -eu
COMPOSE_FILE=compose.staging.yaml
${source.slice(begin, end)}
docker compose -f "$COMPOSE_FILE" stop redis
echo failed-after-stop >&2
exit 1
`;
  const result = run("sh", ["-c", script], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  const trace = readFileSync(log, "utf8");
  rmSync(bin, { recursive: true, force: true });
  assert.equal(result.status, 1);
  assert.match(trace, /stop redis/);
  assert.match(trace, /start redis/);
});

test("review-thread controls are present in the staging workflow", () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/supply-chain.yml"), "utf8");
  const dependabot = readFileSync(path.join(root, ".github/dependabot.yml"), "utf8");
  const deploy = readFileSync(path.join(root, "infra/scripts/staging-deploy.sh"), "utf8");
  const docs = readFileSync(path.join(root, "docs/operations/staging-release.md"), "utf8");
  assert.equal(workflow.includes("scp -r infra") || workflow.includes("-r infra "), false);
  assert.match(workflow, /tar -C infra -cf - \./);
  assert.match(workflow, /docker login ghcr\.io/);
  assert.match(workflow, /STAGING_SILENT_API_URL/);
  assert.match(workflow, /write-staging-env\.py/);
  assert.match(workflow, /--platform linux\/amd64/);
  assert.match(workflow, /trivy image --severity CRITICAL --exit-code 1 redis:7\.4-alpine/);
  assert.match(workflow, /dockerfile: infra\/postgres\/Dockerfile/);
  assert.match(deploy, /ensure_bucket\.py/);
  assert.match(deploy, /S3_ACCESS_KEY_ID/);
  assert.match(docs, /linux\/amd64/);
  for (const directory of [
    "/apps/api",
    "/apps/web",
    "/infra/minio",
    "/infra/object-ingress",
    "/infra/postgres",
    "/workers/agent-worker",
    "/workers/ai-worker",
    "/workers/media-worker",
    "/workers/render-worker",
  ]) {
    assert.match(dependabot, new RegExp(directory.replaceAll("/", "\\/")));
  }
  assert.match(
    readFileSync(path.join(root, "infra/scripts/staging-readiness-measure.sh"), "utf8"),
    /--max-time 2/,
  );
});

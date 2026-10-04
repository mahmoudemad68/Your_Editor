/**
 * The supply-chain workflow scans dependencies and the images compose.yaml
 * already builds or pins. It does not publish images or deploy staging.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

test("compose images and Dockerfiles on main are the scan matrix", () => {
  const workflow = read(".github/workflows/supply-chain.yml");
  const compose = read("compose.yaml");
  const dockerfiles = [...workflow.matchAll(/dockerfile: (\S+)/g)].map((match) => match[1]);
  const composeDockerfiles = [...compose.matchAll(/dockerfile: (\S+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(dockerfiles)].sort(), [...new Set(composeDockerfiles)].sort());
  for (const dockerfile of dockerfiles) {
    read(dockerfile);
  }
  const composeImages = [...compose.matchAll(/^\s+image: (\S+)/gm)].map((match) => match[1]);
  const upstream = [...new Set(composeImages.filter((image) => !image.startsWith("editagent-")))];
  assert.deepEqual(upstream.sort(), ["postgres:16.10-alpine", "redis:7.4-alpine"]);
  for (const image of upstream) {
    assert.equal(workflow.includes(image), true);
  }
  assert.equal(workflow.includes("tools/benchmarks/rendering/docker/Dockerfile"), false);
  assert.equal(workflow.includes("infra/object-ingress/Dockerfile"), false);
  assert.equal(workflow.includes("infra/postgres/Dockerfile"), false);
});

test("the security check reports high and critical findings and does not publish", () => {
  const workflow = read(".github/workflows/supply-chain.yml");
  const scanner = read("infra/scripts/supply-chain-scan-image.sh");
  assert.match(workflow, /supply-chain-security:\n {4}name: supply-chain-security/);
  assert.match(workflow, /actions\/checkout@v7/);
  assert.match(workflow, /actions\/upload-artifact@v7/);
  assert.match(workflow, /actions\/download-artifact@v7/);
  assert.match(workflow, /pnpm\/action-setup@v6/);
  assert.match(workflow, /actions\/setup-node@v7/);
  assert.match(workflow, /actions\/setup-python@v7/);
  assert.match(workflow, /astral-sh\/setup-uv@v10\.2\.0/);
  assert.match(workflow, /gitleaks detect/);
  assert.match(workflow, /pnpm audit --json/);
  assert.match(workflow, /supply-chain-findings\.py/);
  assert.match(scanner, /--severity HIGH,CRITICAL/);
  assert.match(scanner, /--severity CRITICAL \\\n\s+--exit-code 1/);
  assert.match(scanner, /spdx-json=/);
  assert.match(scanner, /vulnerability ignore file is not allowed/);
  assert.equal(workflow.includes("docker push"), false);
  assert.equal(workflow.includes("packages: write"), false);
  assert.equal(workflow.includes("environment: staging"), false);
  assert.equal(workflow.includes("ghcr.io"), false);
  assert.match(scanner, /--ignore-unfixed=false/);
  assert.equal(
    scanner.replaceAll("--ignore-unfixed=false", "").includes("--ignore-unfixed"),
    false,
  );
  assert.match(scanner, /--config=/);
  assert.match(scanner, /--ignorefile=/);
  assert.match(scanner, /--secret-config=/);
  assert.equal(scanner.includes("trivyignore"), true);
  assert.equal(workflow.includes("--ignore-unfixed"), false);
  assert.equal(read(".gitleaks.toml").includes("editagent-dev-password"), true);
  assert.equal(read(".gitleaks.toml").includes("editagent-dev-secret"), true);
});

test("dependabot only watches directories that exist", () => {
  const dependabot = read(".github/dependabot.yml");
  const directories = [...dependabot.matchAll(/directory: (\S+)|- (\/\S+)/g)].map(
    (match) => match[1] ?? match[2],
  );
  assert.equal(directories.length > 0, true);
  for (const directory of directories) {
    const relative = directory === "/" ? "package.json" : `${directory.slice(1)}/Dockerfile`;
    if (directory === "/workers/ai-worker") {
      read("workers/ai-worker/pyproject.toml");
      continue;
    }
    read(relative);
  }
});

test("a vulnerability ignore file stops the scan before a tool runs", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "editagent-ignore-"));
  writeFileSync(path.join(directory, ".trivyignore"), "CVE-2020-0001\n");
  const result = run(
    path.join(root, "infra/scripts/supply-chain-scan-image.sh"),
    ["api", "example"],
    {
      cwd: directory,
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /vulnerability ignore file is not allowed/);
});

test("the security gate rejects a missing or failed scan and accepts a complete pass", () => {
  const required = execFileSync(path.join(root, "infra/scripts/supply-chain-required-scans.sh"), {
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  assert.deepEqual(required, [
    "api",
    "web",
    "media-worker",
    "render-worker",
    "agent-worker",
    "ai-worker",
    "minio",
    "postgres",
    "redis",
    "dependencies",
  ]);
  const gate = path.join(root, "infra/scripts/supply-chain-security-gate.sh");
  const missing = mkdtempSync(path.join(tmpdir(), "editagent-scans-"));
  for (const service of required.slice(0, -1)) {
    writeFileSync(path.join(missing, service), "pass\n");
  }
  const rejected = run(gate, [], { env: { ...process.env, SCAN_DIR: missing } });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /dependencies/);

  const failed = mkdtempSync(path.join(tmpdir(), "editagent-scans-"));
  for (const service of required) {
    writeFileSync(path.join(failed, service), service === "minio" ? "fail\n" : "pass\n");
  }
  const failedResult = run(gate, [], { env: { ...process.env, SCAN_DIR: failed } });
  assert.notEqual(failedResult.status, 0);
  assert.match(failedResult.stderr, /minio/);

  const passed = mkdtempSync(path.join(tmpdir(), "editagent-scans-"));
  for (const service of required) {
    writeFileSync(path.join(passed, service), "pass\n");
  }
  const passedResult = run(gate, [], { env: { ...process.env, SCAN_DIR: passed } });
  assert.equal(passedResult.status, 0, passedResult.stderr);
  assert.match(passedResult.stdout, /supply-chain security gate passed/);
});

test("node and Python reports keep high findings and fail on critical ones", () => {
  const nodeReport = path.join(root, "infra/scripts/node-audit-report.py");
  const highFile = path.join(mkdtempSync(path.join(tmpdir(), "editagent-node-")), "audit.json");
  writeFileSync(
    highFile,
    JSON.stringify({
      advisories: {
        1: {
          severity: "high",
          module_name: "example",
          cves: ["CVE-2026-1000"],
          title: "example high",
        },
      },
    }),
  );
  const high = run("python3", [nodeReport, highFile]);
  assert.equal(high.status, 0, high.stderr);
  assert.match(high.stdout, /HIGH Node vulnerabilities/);
  assert.match(high.stdout, /CVE-2026-1000/);

  const criticalFile = path.join(mkdtempSync(path.join(tmpdir(), "editagent-node-")), "audit.json");
  writeFileSync(
    criticalFile,
    JSON.stringify({
      vulnerabilities: {
        example: {
          severity: "critical",
          via: [{ title: "example critical", url: "CVE-2026-2000" }],
        },
      },
    }),
  );
  const critical = run("python3", [nodeReport, criticalFile]);
  assert.equal(critical.status, 1);
  assert.match(critical.stdout, /CRITICAL Node vulnerabilities/);

  const unknown = run("python3", [
    nodeReport,
    writeJson(mkdtempSync(path.join(tmpdir(), "editagent-node-")), { unexpected: true }),
  ]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /not recognized/);

  const highPython = pythonAudit("HIGH");
  assert.equal(highPython.status, 0, highPython.stderr);
  assert.match(highPython.stdout, /High Python vulnerabilities/);
  const criticalPython = pythonAudit("CRITICAL");
  assert.equal(criticalPython.status, 1);
  assert.match(criticalPython.stdout, /Critical Python vulnerabilities/);
});

test("Trivy findings are printed for high and critical rows", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "editagent-trivy-"));
  writeFileSync(
    path.join(directory, "trivy-api.json"),
    JSON.stringify({
      Results: [
        {
          Target: "api",
          Vulnerabilities: [
            {
              VulnerabilityID: "CVE-2026-3000",
              Severity: "HIGH",
              PkgName: "libc",
              InstalledVersion: "1",
              FixedVersion: "2",
            },
            {
              VulnerabilityID: "CVE-2026-3001",
              Severity: "CRITICAL",
              PkgName: "openssl",
              InstalledVersion: "3",
            },
            {
              VulnerabilityID: "CVE-2026-3002",
              Severity: "LOW",
              PkgName: "ignore-me",
              InstalledVersion: "1",
            },
          ],
        },
      ],
    }),
  );
  const result = run("python3", [
    path.join(root, "infra/scripts/supply-chain-findings.py"),
    directory,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CVE-2026-3000/);
  assert.match(result.stdout, /CVE-2026-3001/);
  assert.match(result.stdout, /fixed=none/);
  assert.equal(result.stdout.includes("CVE-2026-3002"), false);
  assert.match(result.stdout, /critical=1 high=1/);
});

test("a CVSS 4.0 critical vector fails and an unscored finding cannot pass", () => {
  const critical = pythonAuditVector(
    "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N",
    "CVSS_V4",
  );
  assert.equal(critical.status, 1);
  assert.match(critical.stdout, /Critical Python vulnerabilities/);

  const missing = pythonAuditDocument({ id: "PYSEC-2026-1" });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /no severity/);

  const broken = pythonAuditDocument({
    id: "PYSEC-2026-2",
    severity: [{ type: "CVSS_V4", score: "CVSS:4.0/AV:N" }],
  });
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /Unparseable Python vulnerability severities/);
});

test("repository Trivy configuration cannot hide a critical finding", () => {
  for (const config of [
    "vulnerability:\n  ignore-unfixed: true\n",
    "ignorefile: custom.trivyignore\n",
  ]) {
    const directory = mkdtempSync(path.join(tmpdir(), "editagent-trivy-config-"));
    writeFileSync(path.join(directory, "trivy.yaml"), config);
    writeFileSync(path.join(directory, "custom.trivyignore"), "CVE-2026-9999\n");
    const bin = path.join(directory, "bin");
    mkdirSync(bin);
    const log = path.join(directory, "trivy-args.log");
    writeFileSync(
      path.join(bin, "syft"),
      '#!/bin/sh\nfor arg in "$@"; do case "$arg" in spdx-json=*) printf \'{ }\\n\' > "${arg#spdx-json=}" ;; esac; done\nexit 0\n',
    );
    writeFileSync(
      path.join(bin, "trivy"),
      `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [ "$1" = "version" ]; then
  echo Version: test
  exit 0
fi
printf '%s\\n' "$*" | grep -q -- '--config=' || exit 0
printf '%s\\n' "$*" | grep -q -- '--ignorefile=' || exit 0
printf '%s\\n' "$*" | grep -q -- '--secret-config=' || exit 0
printf '%s\\n' "$*" | grep -q -- '--ignore-unfixed=false' || exit 0
output=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "--output" ]; then
    output=$arg
  fi
  previous=$arg
done
if [ -n "$output" ]; then
  printf '%s\\n' '{"Results":[{"Vulnerabilities":[{"VulnerabilityID":"CVE-2026-9999","Severity":"CRITICAL","PkgName":"openssl","InstalledVersion":"1"}]}]}' > "$output"
  exit 0
fi
if printf '%s\\n' "$*" | grep -q -- '--exit-code 1'; then
  exit 1
fi
exit 0
`,
    );
    chmodSync(path.join(bin, "syft"), 0o755);
    chmodSync(path.join(bin, "trivy"), 0o755);
    const result = run(
      path.join(root, "infra/scripts/supply-chain-scan-image.sh"),
      ["api", "example"],
      { cwd: directory, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    );
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(log, "utf8").includes("--ignore-unfixed=false"), true);
    assert.equal(readFileSync(log, "utf8").includes("--config="), true);
    assert.equal(readFileSync(log, "utf8").includes("--ignorefile="), true);
    assert.equal(readFileSync(log, "utf8").includes("--exit-code 1"), true);
    let passExists = true;
    try {
      readFileSync(path.join(directory, "api"), "utf8");
    } catch {
      passExists = false;
    }
    assert.equal(passExists, false);
  }
});

test("a placeholder allowlist does not hide another secret on the same line", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "editagent-gitleaks-"));
  const secret = ["xoxb-123456789012", "-1234567890123", "-abcdefghijklmnopqrstuvwx"].join("");
  writeFileSync(path.join(directory, "placeholder.txt"), "password=editagent-dev-password\n");
  writeFileSync(
    path.join(directory, "mixed.txt"),
    `password=editagent-dev-password slack=${secret}\n`,
  );
  const config = path.join(root, ".gitleaks.toml");
  const gitleaks = gitleaksCommand();
  const placeholder = run(
    gitleaks,
    [
      "detect",
      "--no-git",
      "--source",
      path.join(directory, "placeholder.txt"),
      "--config",
      config,
      "--redact",
      "--exit-code",
      "1",
    ],
    { env: process.env },
  );
  assert.equal(placeholder.status, 0, spawnText(placeholder));
  const mixed = run(gitleaks, [
    "detect",
    "--no-git",
    "--source",
    path.join(directory, "mixed.txt"),
    "--config",
    config,
    "--redact",
    "--exit-code",
    "1",
  ]);
  assert.equal(mixed.status, 1, spawnText(mixed));
});

test("the Python audit includes locked development dependencies", () => {
  const script = read("infra/scripts/audit-python.sh");
  assert.equal(script.includes("--no-dev"), false);
  assert.match(script, /--all-groups/);
  assert.match(script, /unset UV_NO_DEV/);
  assert.match(script, /unset UV_NO_GROUP/);
  assert.match(script, /unset UV_NO_DEFAULT_GROUPS/);
  const exportEnv = { ...process.env };
  delete exportEnv.UV_NO_DEV;
  delete exportEnv.UV_NO_GROUP;
  delete exportEnv.UV_NO_DEFAULT_GROUPS;
  const exported = execFileSync(
    "uv",
    [
      "export",
      "--project",
      path.join(root, "workers/ai-worker"),
      "--frozen",
      "--all-groups",
      "--no-emit-project",
      "--no-hashes",
      "--format",
      "requirements-txt",
    ],
    { encoding: "utf8", env: exportEnv },
  );
  for (const name of ["ruff==", "mypy==", "pytest==", "import-linter=="]) {
    assert.equal(exported.includes(name), true, name);
  }
});

function spawnText(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`;
}

function gitleaksCommand() {
  const found = run("gitleaks", ["version"]);
  if (found.status === 0) {
    return "gitleaks";
  }
  const bin = mkdtempSync(path.join(tmpdir(), "editagent-gitleaks-bin-"));
  const install = run(
    path.join(root, "infra/scripts/install-supply-chain-tools.sh"),
    ["gitleaks"],
    {
      env: {
        ...process.env,
        SUPPLY_CHAIN_BIN: bin,
        PATH: "/usr/bin:/bin",
      },
    },
  );
  assert.equal(install.status, 0, spawnText(install));
  return path.join(bin, "gitleaks");
}

function writeJson(directory, value) {
  const file = path.join(directory, "audit.json");
  writeFileSync(file, JSON.stringify(value));
  return file;
}

function pythonAuditVector(vector, type) {
  return pythonAuditDocument({
    id: "CVE-2026-4000",
    severity: [{ type, score: vector }],
  });
}

function pythonAuditDocument(document) {
  const directory = mkdtempSync(path.join(tmpdir(), "editagent-python-"));
  writeFileSync(path.join(directory, `${document.id}.json`), JSON.stringify(document));
  const report = path.join(directory, "report.json");
  writeFileSync(
    report,
    JSON.stringify({
      dependencies: [{ name: "demo", version: "1", vulns: [{ id: document.id }] }],
    }),
  );
  return run("python3", [path.join(root, "infra/scripts/python_audit_report.py"), report, "1"], {
    env: { ...process.env, PYTHON_AUDIT_OSV_FIXTURE: directory },
  });
}

function pythonAudit(severity) {
  const directory = mkdtempSync(path.join(tmpdir(), "editagent-python-"));
  const vector =
    severity === "CRITICAL"
      ? "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"
      : "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N";
  writeFileSync(
    path.join(directory, "CVE-2026-4000.json"),
    JSON.stringify({ severity: [{ type: "CVSS_V3", score: vector }] }),
  );
  const report = path.join(directory, "report.json");
  writeFileSync(
    report,
    JSON.stringify({
      dependencies: [{ name: "demo", version: "1", vulns: [{ id: "CVE-2026-4000" }] }],
    }),
  );
  return run("python3", [path.join(root, "infra/scripts/python_audit_report.py"), report, "1"], {
    env: { ...process.env, PYTHON_AUDIT_OSV_FIXTURE: directory },
  });
}

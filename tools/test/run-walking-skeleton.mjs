/** Disposable real production composition. No fixture API or direct DB inserts. */
import { command, buildProductImages } from "./compose-build.mjs";
import { verifyReadinessCycles } from "./readiness-cycles.mjs";
import { assertBrokenMetadataProof } from "./walking-skeleton-proof.mjs";
import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { Buffer } from "node:buffer";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { S3Client, CreateBucketCommand, PutBucketCorsCommand } from "@aws-sdk/client-s3";

const root = path.resolve(import.meta.dirname, "../.."),
  artifacts = path.join(root, ".local/walking-skeleton-artifacts");
const secretFile = path.join(root, ".local/walking-skeleton-secret-values.json");
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: "walking-skeleton",
  EDITAGENT_RUNTIME: "development",
  AUTH_COOKIE_SECURE: "false",
  AUTH_TRUSTED_ORIGINS: "http://localhost:3000",
};
const compose = (args) => command("docker", ["compose", ...args], { cwd: root, env });
const signal = new globalThis.AbortController();
for (const name of ["SIGINT", "SIGTERM"]) process.once(name, () => signal.abort());
const require = createRequire(path.join(root, "apps/web/package.json"));
function browser(scenario) {
  const result = spawnSync(
    process.execPath,
    [
      require.resolve("@playwright/test/cli"),
      "test",
      "--config",
      "tests/walking-skeleton.config.ts",
    ],
    {
      cwd: path.join(root, "apps/web"),
      stdio: "inherit",
      timeout: 240000,
      env: {
        ...env,
        WALKING_SKELETON_SCENARIO: scenario,
        ...(scenario === "negative" ? { WALKING_SKELETON_METADATA_TIMEOUT_MS: "8000" } : {}),
      },
    },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}
async function diagnostics(destination = artifacts) {
  mkdirSync(destination, { recursive: true });
  writeFileSync(
    path.join(destination, "captured-at.json"),
    JSON.stringify({ capturedAt: new Date().toISOString() }),
  );
  for (const [file, args] of [
    ["compose-ps.json", ["ps", "--all", "--format", "json"]],
    ["services.log", ["logs", "--no-color", "--timestamps"]],
  ]) {
    const result = spawnSync("docker", ["compose", ...args], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 30000,
    });
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    writeFileSync(path.join(destination, file), output);
    if (file === "services.log")
      writeFileSync(
        path.join(destination, "services-log-input.json"),
        JSON.stringify({
          file,
          ansiBeforeSanitization: [...output].some((c) => [27, 155, 157].includes(c.charCodeAt(0))),
          controlsBeforeSanitization: [...output].some((c) => {
            const code = c.charCodeAt(0);
            return (code < 32 && ![9, 10, 13].includes(code)) || (code >= 127 && code <= 159);
          }),
        }),
      );
  }
  const result = spawnSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      env.POSTGRES_USER ?? "editagent",
      "-d",
      env.POSTGRES_DB ?? "editagent",
      "-c",
      "SELECT id, job_type, status, attempt_count, created_at, updated_at FROM jobs ORDER BY created_at;",
    ],
    { cwd: root, env, encoding: "utf8", timeout: 10000 },
  );
  writeFileSync(
    path.join(destination, "durable-jobs.txt"),
    (result.stdout ?? "") + (result.stderr ?? ""),
  );
}
try {
  rmSync(secretFile, { force: true });
  rmSync(artifacts, { recursive: true, force: true });
  mkdirSync(artifacts, { recursive: true });
  await compose(["down", "-v", "--remove-orphans"]);
  await compose(["config", "--quiet"]);
  if (!process.argv.includes("--skip-build"))
    await buildProductImages(root, ["api", "web", "media-worker", "postgres", "redis"]);
  await compose(["up", "-d", "--wait", "--wait-timeout", "120", "postgres", "redis"]);
  await command("sh", ["infra/seaweedfs/start-storage.sh", "--from-boot"], {
    cwd: root,
    env,
    signal: signal.signal,
  });
  const s3 = new S3Client({
    endpoint: `http://localhost:${env.S3_PORT ?? 9000}`,
    region: env.S3_REGION ?? "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID ?? "editagent",
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "editagent-dev-secret",
    },
  });
  try {
    await s3.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET ?? "editagent" }));
    await s3.send(
      new PutBucketCorsCommand({
        Bucket: env.S3_BUCKET ?? "editagent",
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: ["http://localhost:3000"],
              AllowedMethods: ["PUT", "GET", "HEAD"],
              AllowedHeaders: ["*"],
              ExposeHeaders: ["ETag"],
              MaxAgeSeconds: 60,
            },
          ],
        },
      }),
    );
  } finally {
    s3.destroy();
  }
  await compose([
    "up",
    "-d",
    "--no-build",
    "--wait",
    "--wait-timeout",
    "120",
    "api",
    "web",
    "media-worker",
  ]);
  if (process.argv.includes("--verify-failure")) {
    await compose(["stop", "media-worker"]);
    const code = browser("negative");
    const report = readFileSync(path.join(artifacts, "negative/results.json"), "utf8");
    assertBrokenMetadataProof(JSON.parse(report), code);
    const negativeRuntime = path.join(artifacts, "negative/runtime");
    await diagnostics(negativeRuntime);
    writeFileSync(
      path.join(artifacts, "negative/runtime/negative-proof.json"),
      JSON.stringify(
        {
          result: "FAIL_AS_EXPECTED",
          exitCode: code,
          mechanism: "media-worker stopped; real UI upload; bounded 8-second metadata assertion",
        },
        null,
        2,
      ),
    );
    execFileSync(
      "python3",
      [
        "tools/test/sanitize-artifacts.py",
        path.join(artifacts, "negative"),
        "--secret-file",
        secretFile,
      ],
      { cwd: root, stdio: "inherit" },
    );
    console.log("NEGATIVE_DIAGNOSTICS_CAPTURED_BEFORE_WORKER_RESTART", negativeRuntime);
    console.log("BROKEN_METADATA_FLOW_TEST_RESULT FAIL_AS_EXPECTED");
    await compose(["up", "-d", "--no-build", "--wait", "media-worker"]);
  }
  const code = browser("healthy");
  if (code !== 0) throw new Error(`Walking skeleton failed (${code})`);
  // Read-only proof from the actual browser-generated ID, durable Job and
  // production JSON logs. No handcrafted header or fixture API participates.
  const report = JSON.parse(readFileSync(path.join(artifacts, "healthy/results.json"), "utf8"));
  const findEvidence = (value) => {
    if (value && typeof value === "object") {
      if (value.name === "walking-skeleton-evidence" && value.body)
        return JSON.parse(Buffer.from(value.body, "base64").toString("utf8"));
      for (const child of Object.values(value)) {
        const result = findEvidence(child);
        if (result) return result;
      }
    }
  };
  const evidence = findEvidence(report);
  if (!evidence || !/^req_[a-f0-9]{32}$/.test(evidence.uploadCorrelationId))
    throw new Error("Browser correlation evidence missing");
  const job = evidence.jobSnapshot.job.jobId;
  if (!/^[a-f0-9-]{36}$/.test(job)) throw new Error("Invalid Job evidence identity");
  const persisted = execFileSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      env.POSTGRES_USER ?? "editagent",
      "-d",
      env.POSTGRES_DB ?? "editagent",
      "-Atc",
      `SELECT payload->>'correlationId' FROM jobs WHERE id = '${job}'::uuid`,
    ],
    { cwd: root, env, encoding: "utf8", timeout: 10000 },
  ).trim();
  const lines = (service) =>
    execFileSync("docker", ["compose", "logs", "--no-color", service], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 10000,
    })
      .split("\n")
      .flatMap((line) => {
        const start = line.indexOf("{");
        if (start < 0) return [];
        try {
          return [JSON.parse(line.slice(start))];
        } catch {
          return [];
        }
      });
  const api = lines("api").filter((line) => line.correlationId === persisted);
  const worker = lines("media-worker").filter((line) => line.jobId === job);
  if (
    persisted !== evidence.uploadCorrelationId ||
    !api.some((line) => line.message === "job.accepted") ||
    !api.some((line) => line.message === "request.received") ||
    worker.length < 2 ||
    worker.some((line) => line.correlationId !== persisted)
  )
    throw new Error("Web/API/PostgreSQL/worker correlation chain differs");
  const correlationProof = {
    requestId: persisted,
    jobId: job,
    apiLines: api.length,
    workerLines: worker.length,
    allWorkerJobLinesMatch: true,
    productionBrowserHeader: true,
  };
  writeFileSync(
    path.join(artifacts, "healthy/correlation-proof.json"),
    JSON.stringify(correlationProof),
  );
  console.log("US115_CORRELATION_EVIDENCE", JSON.stringify(correlationProof));
  const readinessProof = await verifyReadinessCycles(root, env);
  writeFileSync(
    path.join(artifacts, "healthy/readiness-proof.json"),
    JSON.stringify(readinessProof),
  );
  execFileSync(
    "python3",
    [
      "infra/scripts/staging_smoke.py",
      "--local-test",
      "--services",
      "api,web,media-worker,postgres,redis,seaweed-master,seaweed-volume,seaweed-filer,seaweed-s3",
      "--timeout",
      "30",
    ],
    { cwd: root, env, stdio: "inherit" },
  );
  await diagnostics(path.join(artifacts, "healthy/runtime"));
} finally {
  try {
    await diagnostics();
    execFileSync(
      "python3",
      ["tools/test/sanitize-artifacts.py", artifacts, "--secret-file", secretFile],
      { cwd: root, stdio: "inherit" },
    );
    execFileSync(
      "python3",
      ["tools/test/audit-artifacts.py", artifacts, "--secret-file", secretFile],
      { cwd: root, stdio: "inherit" },
    );
    rmSync(secretFile, { force: true });
  } finally {
    await compose(["down", "-v", "--remove-orphans"]);
  }
}

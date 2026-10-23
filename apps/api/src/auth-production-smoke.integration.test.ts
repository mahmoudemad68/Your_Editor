/**
 * Production bootstrap smoke. Staging must refuse authentication cookies that
 * are not marked Secure, and a staging process with Secure cookies can register.
 * API test files run serially: concurrent cold Nest boots plus password hashing
 * must not oversubscribe the CI CPU budget. The startup deadline stays 10s.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { Pool } from "pg";

const TEST_DATABASE = "editagent_us118_smoke";
const SECRET = "local-development-jwt-secret-32chars";
const PASSWORD = "correct-horse-battery";

function adminUrl(): string {
  return (
    process.env["DATABASE_URL"] ??
    "postgresql://editagent:editagent-dev-password@127.0.0.1:5432/editagent"
  );
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function runtimeEnv(databaseUrl: string, runtime: string, cookieSecure: string, port: string) {
  const endpoint = process.env["S3_ENDPOINT"] ?? "http://127.0.0.1:9000";
  return {
    ...process.env,
    DATABASE_URL: databaseUrl,
    REDIS_URL: process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379/0",
    PORT: port,
    HOST: "127.0.0.1",
    S3_ENDPOINT: endpoint,
    S3_PUBLIC_ENDPOINT: process.env["S3_PUBLIC_ENDPOINT"] ?? endpoint,
    S3_BUCKET: process.env["S3_BUCKET"] ?? "editagent",
    S3_ACCESS_KEY_ID: process.env["S3_ACCESS_KEY_ID"] ?? "editagent",
    S3_SECRET_ACCESS_KEY: process.env["S3_SECRET_ACCESS_KEY"] ?? "editagent-dev-secret",
    S3_REGION: process.env["S3_REGION"] ?? "us-east-1",
    AUTH_JWT_SECRET: SECRET,
    EDITAGENT_RUNTIME: runtime,
    AUTH_COOKIE_SECURE: cookieSecure,
    AUTH_TRUSTED_ORIGINS: "https://staging.editagent.test",
  };
}

test("staging refuses insecure authentication cookies and a secure process can sign in", async () => {
  const refused = spawnSync(process.execPath, [path.resolve(__dirname, "main.js")], {
    env: runtimeEnv(adminUrl(), "staging", "false", "34119"),
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stderr}\n${refused.stdout}`, /AUTH_COOKIE_SECURE/);

  const admin = new Pool({ connectionString: adminUrl() });
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
  await admin.end();
  const databaseUrl = withDatabase(adminUrl(), TEST_DATABASE);
  const child: ChildProcess = spawn(process.execPath, [path.resolve(__dirname, "main.js")], {
    env: runtimeEnv(databaseUrl, "staging", "true", "34118"),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  try {
    const base = "http://127.0.0.1:34118";
    let ready = false;
    let lastStatus: number | null = null;
    const startedAt = performance.now();
    const deadline = startedAt + 10_000;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const remaining = deadline - performance.now();
      if (remaining <= 0 || child.exitCode !== null || child.signalCode !== null) break;
      try {
        const health = await fetch(`${base}/health`, {
          signal: AbortSignal.timeout(Math.max(1, Math.min(250, Math.floor(remaining)))),
        });
        lastStatus = health.status;
        await health.arrayBuffer();
        if (health.status === 200) {
          ready = true;
          break;
        }
      } catch {
        /* Startup has not bound its socket yet. */
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, Math.min(250, deadline - performance.now()))),
      );
    }
    assert.equal(
      ready,
      true,
      `Production bootstrap did not become healthy within 10s; lastStatus=${lastStatus}, exitCode=${child.exitCode}. ${output}`,
    );
    const registered = await fetch(`${base}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "staging@example.test", password: PASSWORD }),
    });
    assert.equal(registered.status, 201, await registered.clone().text());
    const cookies = registered.headers.getSetCookie?.().join("\n") ?? "";
    assert.match(cookies, /editagent_access=[^\n]*Secure/);
    assert.match(cookies, /editagent_refresh=[^\n]*Secure/);
    const anonymous = await fetch(`${base}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nope" }),
    });
    assert.equal(anonymous.status, 401);
    const jar = new Map<string, string>();
    for (const line of registered.headers.getSetCookie?.() ?? []) {
      const pair = line.split(";")[0] ?? "";
      const split = pair.indexOf("=");
      if (split > 0) {
        jar.set(pair.slice(0, split), decodeURIComponent(pair.slice(split + 1)));
      }
    }
    const created = await fetch(`${base}/projects`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: [...jar.entries()]
          .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
          .join("; "),
        "x-editagent-csrf": jar.get("editagent_csrf") ?? "",
      },
      body: JSON.stringify({ name: "Launch" }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const refreshed = await fetch(`${base}/auth/refresh`, {
      method: "POST",
      headers: {
        cookie: [...jar.entries()]
          .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
          .join("; "),
        "x-editagent-csrf": jar.get("editagent_csrf") ?? "",
      },
    });
    assert.equal(refreshed.status, 200, await refreshed.clone().text());
  } finally {
    child.kill("SIGTERM");
    await exited;
  }
});

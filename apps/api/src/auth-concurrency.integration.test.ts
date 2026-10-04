/**
 * Cross-process authentication races against real PostgreSQL.
 * Two API processes share one database. An in-process mutex cannot pass these tests.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { createUuidV7, RefreshSession, userId } from "@editagent/domain";
import { Pool } from "pg";
import { PostgresRefreshSessionRepository } from "./infrastructure/postgres-identity-repository.js";
import { applyMigrations } from "./infrastructure/migrate.js";

const TEST_DATABASE = "editagent_us118_race";
const SECRET = "local-development-jwt-secret-32chars";
const PASSWORD = "correct-horse-battery";
const WRONG = "not-the-password";
const PAIR_TRIALS = 24;
const LOCK_TRIALS = 20;

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

function cookieJar(response: Response): Map<string, string> {
  const jar = new Map<string, string>();
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const pair = line.split(";")[0] ?? "";
    const split = pair.indexOf("=");
    if (split > 0) {
      jar.set(pair.slice(0, split), decodeURIComponent(pair.slice(split + 1)));
    }
  }
  return jar;
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()]
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");
}

function sessionId(token: string): string {
  return token.slice(0, token.indexOf("."));
}

async function startServer(databaseUrl: string): Promise<{ child: ChildProcess; base: string }> {
  const child = spawn(process.execPath, [path.resolve(__dirname, "auth-concurrency-server.js")], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      REDIS_URL: process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379/0",
      S3_ENDPOINT: process.env["S3_ENDPOINT"] ?? "http://127.0.0.1:9000",
      S3_PUBLIC_ENDPOINT:
        process.env["S3_PUBLIC_ENDPOINT"] ?? process.env["S3_ENDPOINT"] ?? "http://127.0.0.1:9000",
      S3_BUCKET: process.env["S3_BUCKET"] ?? "editagent",
      S3_ACCESS_KEY_ID: process.env["S3_ACCESS_KEY_ID"] ?? "editagent",
      S3_SECRET_ACCESS_KEY: process.env["S3_SECRET_ACCESS_KEY"] ?? "editagent-dev-secret",
      S3_REGION: process.env["S3_REGION"] ?? "us-east-1",
      AUTH_JWT_SECRET: SECRET,
      EDITAGENT_RUNTIME: "development",
      AUTH_COOKIE_SECURE: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`auth server did not start\n${output}`)),
      20_000,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/AUTH_SERVER_READY port=(\d+)/);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`auth server exited ${code}\n${output}`));
    });
  });
  return { child, base };
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", () => resolve(undefined)));
}

async function postJson(
  base: string,
  pathName: string,
  body: unknown,
  jar?: Map<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (jar !== undefined) {
    headers.cookie = cookieHeader(jar);
    headers["x-editagent-csrf"] = jar.get("editagent_csrf") ?? "";
  }
  return fetch(`${base}${pathName}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function refresh(base: string, jar: Map<string, string>): Promise<Response> {
  return fetch(`${base}/auth/refresh`, {
    method: "POST",
    headers: {
      cookie: cookieHeader(jar),
      "x-editagent-csrf": jar.get("editagent_csrf") ?? "",
    },
  });
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`missing ${label}`);
  }
  return value;
}

async function together<T>(work: readonly (() => Promise<T>)[]): Promise<T[]> {
  const releaseAt = Date.now() + 40;
  return Promise.all(
    work.map(async (run) => {
      while (Date.now() < releaseAt) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return run();
    }),
  );
}

interface SessionRow {
  id: string;
  rotated_from_id: string | null;
  revoked_at: string | null;
}

async function sessionsFor(pool: Pool, email: string): Promise<SessionRow[]> {
  const result = await pool.query<SessionRow>(
    `SELECT s.id::text AS id, s.rotated_from_id::text AS rotated_from_id, s.revoked_at::text AS revoked_at
     FROM refresh_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE u.email = $1`,
    [email],
  );
  return result.rows;
}

function activeCount(rows: readonly SessionRow[]): number {
  return rows.filter((row) => row.revoked_at === null).length;
}

test("refresh consumption and account lockout are atomic across two API processes", async () => {
  const admin = new Pool({ connectionString: adminUrl() });
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
  await admin.end();
  const databaseUrl = withDatabase(adminUrl(), TEST_DATABASE);
  const pool = new Pool({ connectionString: databaseUrl });
  await applyMigrations(pool);
  const left = await startServer(databaseUrl);
  const right = await startServer(databaseUrl);
  try {
    const registered = await postJson(left.base, "/auth/register", {
      email: "racer@example.test",
      password: PASSWORD,
    });
    assert.equal(registered.status, 201, await registered.clone().text());
    const unknown = await postJson(left.base, "/auth/login", {
      email: "missing@example.test",
      password: PASSWORD,
    });
    const unknownBody = (await unknown.json()) as { message: string };
    assert.equal(unknown.status, 401);
    assert.equal(unknownBody.message, "Email or password is incorrect.");

    for (let trial = 0; trial < PAIR_TRIALS; trial += 1) {
      const loggedIn = await postJson(trial % 2 === 0 ? left.base : right.base, "/auth/login", {
        email: "racer@example.test",
        password: PASSWORD,
      });
      assert.equal(loggedIn.status, 200, await loggedIn.clone().text());
      const jar = cookieJar(loggedIn);
      const presented = sessionId(jar.get("editagent_refresh") ?? "");
      const raced = await together([() => refresh(left.base, jar), () => refresh(right.base, jar)]);
      const first = required(raced[0], "first refresh");
      const second = required(raced[1], "second refresh");
      const statuses = [first.status, second.status].sort((a, b) => a - b);
      assert.deepEqual(statuses, [200, 401], `pair trial ${trial} returned ${statuses.join(",")}`);
      const rows = await sessionsFor(pool, "racer@example.test");
      const consumed = rows.find((row) => row.id === presented);
      assert.notEqual(consumed?.revoked_at, null);
      const replacements = rows.filter((row) => row.rotated_from_id === presented);
      assert.equal(
        replacements.length,
        1,
        `trial ${trial} created ${replacements.length} replacements`,
      );
      assert.notEqual(replacements[0]?.revoked_at, null);
      assert.equal(
        activeCount(rows),
        0,
        `trial ${trial} left ${activeCount(rows)} active sessions`,
      );
    }

    const fanoutLogin = await postJson(left.base, "/auth/login", {
      email: "racer@example.test",
      password: PASSWORD,
    });
    const fanoutJar = cookieJar(fanoutLogin);
    const fanoutId = sessionId(fanoutJar.get("editagent_refresh") ?? "");
    const fanout = await together(
      Array.from(
        { length: 8 },
        (_, index) => () => refresh(index % 2 === 0 ? left.base : right.base, fanoutJar),
      ),
    );
    assert.equal(fanout.filter((response) => response.status === 200).length, 1);
    const fanoutRows = await sessionsFor(pool, "racer@example.test");
    assert.equal(fanoutRows.filter((row) => row.rotated_from_id === fanoutId).length, 1);
    assert.equal(activeCount(fanoutRows), 0);

    const sequentialLogin = await postJson(left.base, "/auth/login", {
      email: "racer@example.test",
      password: PASSWORD,
    });
    const sequentialJar = cookieJar(sequentialLogin);
    const rotated = await refresh(left.base, sequentialJar);
    assert.equal(rotated.status, 200, await rotated.clone().text());
    const rotatedJar = cookieJar(rotated);
    const replay = await refresh(right.base, sequentialJar);
    assert.equal(replay.status, 401);
    const replayReplacement = await refresh(left.base, rotatedJar);
    assert.equal(replayReplacement.status, 401);
    assert.equal(activeCount(await sessionsFor(pool, "racer@example.test")), 0);

    const currentLogin = await postJson(left.base, "/auth/login", {
      email: "racer@example.test",
      password: PASSWORD,
    });
    const currentJar = cookieJar(currentLogin);
    const currentToken = currentJar.get("editagent_refresh") ?? "";
    const staleLogin = await postJson(right.base, "/auth/login", {
      email: "racer@example.test",
      password: PASSWORD,
    });
    const staleJar = cookieJar(staleLogin);
    const primed = await refresh(left.base, staleJar);
    assert.equal(primed.status, 200, await primed.clone().text());
    const mixedRefresh = await together([
      () => refresh(left.base, currentJar),
      () => refresh(right.base, staleJar),
    ]);
    const legitimate = required(mixedRefresh[0], "legitimate refresh");
    const stale = required(mixedRefresh[1], "stale refresh");
    assert.equal(stale.status, 401);
    assert.ok(legitimate.status === 200 || legitimate.status === 401);
    assert.equal(
      [legitimate.status, stale.status].filter((status) => status === 200).length <= 1,
      true,
    );
    assert.equal(activeCount(await sessionsFor(pool, "racer@example.test")), 0);
    assert.notEqual(sessionId(currentToken), "");

    const logoutLogin = await postJson(left.base, "/auth/login", {
      email: "racer@example.test",
      password: PASSWORD,
    });
    const otherLogin = await postJson(right.base, "/auth/login", {
      email: "racer@example.test",
      password: PASSWORD,
    });
    const logoutJar = cookieJar(logoutLogin);
    const otherJar = cookieJar(otherLogin);
    const loggedOut = await fetch(`${left.base}/auth/logout`, {
      method: "POST",
      headers: {
        cookie: cookieHeader(logoutJar),
        "x-editagent-csrf": logoutJar.get("editagent_csrf") ?? "",
      },
    });
    assert.equal(loggedOut.status, 204);
    const afterLogout = await sessionsFor(pool, "racer@example.test");
    assert.notEqual(
      afterLogout.find((row) => row.id === sessionId(logoutJar.get("editagent_refresh") ?? ""))
        ?.revoked_at,
      null,
    );
    assert.equal(
      afterLogout.find((row) => row.id === sessionId(otherJar.get("editagent_refresh") ?? ""))
        ?.revoked_at,
      null,
    );
    assert.equal((await refresh(right.base, logoutJar)).status, 401);
    assert.equal(activeCount(await sessionsFor(pool, "racer@example.test")), 0);

    const failureLogin = await postJson(left.base, "/auth/login", {
      email: "racer@example.test",
      password: PASSWORD,
    });
    const failureJar = cookieJar(failureLogin);
    const failureId = sessionId(failureJar.get("editagent_refresh") ?? "");
    await pool.query(`
      CREATE OR REPLACE FUNCTION editagent_fail_refresh_replacement() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.rotated_from_id IS NOT NULL THEN
          RAISE EXCEPTION 'replacement insert failed';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await pool.query(`
      CREATE TRIGGER editagent_fail_refresh_replacement
      BEFORE INSERT ON refresh_sessions
      FOR EACH ROW EXECUTE FUNCTION editagent_fail_refresh_replacement()
    `);
    try {
      const failed = await refresh(left.base, failureJar);
      assert.equal(failed.status, 500);
      const duringFailure = await sessionsFor(pool, "racer@example.test");
      assert.equal(duringFailure.find((row) => row.id === failureId)?.revoked_at, null);
      assert.equal(duringFailure.filter((row) => row.rotated_from_id === failureId).length, 0);
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS editagent_fail_refresh_replacement ON refresh_sessions",
      );
      await pool.query("DROP FUNCTION IF EXISTS editagent_fail_refresh_replacement()");
    }
    const recovered = await refresh(right.base, failureJar);
    assert.equal(recovered.status, 200, await recovered.clone().text());

    const sessions = new PostgresRefreshSessionRepository(pool);
    const owner = await pool.query<{ id: string }>(
      "SELECT id::text AS id FROM users WHERE email = $1",
      ["racer@example.test"],
    );
    const ownerId = userId(owner.rows[0]?.id ?? "");
    const issued = RefreshSession.issue(
      createUuidV7(Date.now(), randomBytes(10)),
      ownerId,
      "b".repeat(64),
      BigInt(Date.now()),
      BigInt(Date.now()) + 60_000n,
      null,
    );
    await sessions.save(issued);
    await assert.rejects(() =>
      sessions.rotate(
        issued.id,
        BigInt(Date.now()),
        () => ({
          action: "replace",
          replacement: RefreshSession.issue(
            createUuidV7(Date.now(), randomBytes(10)),
            ownerId,
            "c".repeat(64),
            BigInt(Date.now()),
            BigInt(Date.now()) + 60_000n,
            issued.id,
          ),
        }),
        async () => {
          throw new Error("access token issuance failed");
        },
      ),
    );
    assert.equal((await sessions.findById(issued.id))?.revokedAt, null);

    for (let trial = 0; trial < LOCK_TRIALS; trial += 1) {
      await pool.query(
        "UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE email = $1",
        ["racer@example.test"],
      );
      const failures = await together(
        Array.from(
          { length: 5 },
          (_, index) => () =>
            postJson(index % 2 === 0 ? left.base : right.base, "/auth/login", {
              email: "racer@example.test",
              password: WRONG,
            }),
        ),
      );
      for (const response of failures) {
        assert.equal(response.status, 401);
        const body = (await response.json()) as { message: string };
        assert.deepEqual(body, unknownBody);
        assert.equal(JSON.stringify(body).toLowerCase().includes("lock"), false);
      }
      const locked = await pool.query<{ failed_login_count: number; locked_until: string | null }>(
        "SELECT failed_login_count, locked_until::text AS locked_until FROM users WHERE email = $1",
        ["racer@example.test"],
      );
      assert.equal(locked.rows[0]?.failed_login_count, 5, `lock trial ${trial}`);
      assert.notEqual(locked.rows[0]?.locked_until, null);
      const correct = await postJson(left.base, "/auth/login", {
        email: "racer@example.test",
        password: PASSWORD,
      });
      assert.equal(correct.status, 401);
      assert.deepEqual(await correct.json(), unknownBody);
    }

    for (let trial = 0; trial < LOCK_TRIALS; trial += 1) {
      await pool.query(
        "UPDATE users SET failed_login_count = 4, locked_until = NULL, updated_at = created_at WHERE email = $1",
        ["racer@example.test"],
      );
      const mixedLogin = await together([
        () =>
          postJson(left.base, "/auth/login", {
            email: "racer@example.test",
            password: PASSWORD,
          }),
        () =>
          postJson(right.base, "/auth/login", {
            email: "racer@example.test",
            password: WRONG,
          }),
      ]);
      const success = required(mixedLogin[0], "successful login");
      const failure = required(mixedLogin[1], "failed login");
      const state = await pool.query<{ failed_login_count: number; locked_until: string | null }>(
        "SELECT failed_login_count, locked_until::text AS locked_until FROM users WHERE email = $1",
        ["racer@example.test"],
      );
      const lockedUntil = state.rows[0]?.locked_until;
      const count = state.rows[0]?.failed_login_count ?? 0;
      if (success.status === 200) {
        assert.equal(lockedUntil, null, `trial ${trial} cleared an active lock`);
        assert.ok(count === 0 || count === 1);
      } else {
        assert.equal(success.status, 401);
        assert.notEqual(lockedUntil, null);
        assert.ok(count >= 5);
      }
      assert.equal(failure.status, 401);
      assert.deepEqual(await failure.json(), unknownBody);
    }

    const until = BigInt(Date.now()) + 15n * 60n * 1000n;
    await pool.query(
      "UPDATE users SET failed_login_count = 5, locked_until = $2, updated_at = created_at WHERE email = $1",
      ["racer@example.test", until.toString()],
    );
    const whileLocked = await together(
      Array.from(
        { length: 8 },
        (_, index) => () =>
          postJson(index % 2 === 0 ? left.base : right.base, "/auth/login", {
            email: "racer@example.test",
            password: PASSWORD,
          }),
      ),
    );
    for (const response of whileLocked) {
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), unknownBody);
    }
    const preserved = await pool.query<{ failed_login_count: number; locked_until: string }>(
      "SELECT failed_login_count, locked_until::text AS locked_until FROM users WHERE email = $1",
      ["racer@example.test"],
    );
    assert.equal(preserved.rows[0]?.failed_login_count, 5);
    assert.equal(preserved.rows[0]?.locked_until, until.toString());
  } finally {
    await stopServer(left.child);
    await stopServer(right.child);
    await pool.end();
  }
});

/**
 * Regressions for the confirmed code-review findings that do not need two processes.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import { createServiceLogger } from "@editagent/shared";
import { instant, type Instant } from "@editagent/domain";
import {
  LoginUser,
  LogoutUser,
  RefreshAccess,
  RegisterUser,
} from "./application/authentication.js";
import { type Clock } from "./application/clock.js";
import {
  InMemoryRefreshSessionRepository,
  InMemoryUserRepository,
} from "./application/in-memory-identity.js";
import { InMemoryMediaAssetRepository } from "./application/in-memory-media-repository.js";
import { InMemoryProjectRepository } from "./application/in-memory-project-repository.js";
import { LoginRateLimit } from "./application/login-rate-limit.js";
import { MemoryObjectStorage } from "./application/memory-object-storage.js";
import { createApiApplication } from "./create-api-application.js";
import { Argon2idHasher } from "./infrastructure/argon2id-hasher.js";
import { applyMigrations } from "./infrastructure/migrate.js";
import { JwtSessionTokens } from "./infrastructure/jwt-session-tokens.js";
import { NodeMediaAssetIdGenerator } from "./infrastructure/node-media-asset-id-generator.js";
import { NodeProjectIdGenerator } from "./infrastructure/node-project-id-generator.js";
import {
  PostgresRefreshSessionRepository,
  PostgresUserRepository,
} from "./infrastructure/postgres-identity-repository.js";
import { PostgresProjectRepository } from "./infrastructure/postgres-project-repository.js";
import { Pool } from "pg";

const SECRET = "local-development-jwt-secret-32chars";
const PASSWORD = "correct-horse-battery";

class MutableClock implements Clock {
  now(): Instant {
    return instant(1_700_000_000_000n);
  }
}

async function start(
  trustedOrigins: readonly string[] = [],
  logger = createServiceLogger("api"),
): Promise<{
  base: string;
  close: () => Promise<void>;
}> {
  const clock = new MutableClock();
  const users = new InMemoryUserRepository();
  const sessions = new InMemoryRefreshSessionRepository();
  const passwords = new Argon2idHasher();
  const tokens = new JwtSessionTokens(SECRET);
  const rateLimit = new LoginRateLimit(100, 60_000);
  const app = await createApiApplication(
    {
      projects: new InMemoryProjectRepository(),
      clock,
      ids: new NodeProjectIdGenerator(),
      media: new InMemoryMediaAssetRepository(),
      objects: new MemoryObjectStorage(),
      mediaIds: new NodeMediaAssetIdGenerator(),
      presignTtlSeconds: 900,
      auth: {
        register: new RegisterUser(users, sessions, passwords, tokens, clock, rateLimit),
        login: new LoginUser(users, sessions, passwords, tokens, clock, rateLimit),
        refresh: new RefreshAccess(users, sessions, tokens, clock),
        logout: new LogoutUser(sessions, clock),
        tokens,
        now: () => clock.now(),
        cookieSecure: false,
        trustedOrigins,
        trustedProxies: [],
      },
    },
    undefined,
    logger,
  );
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a port");
  }
  return { base: `http://127.0.0.1:${address.port}`, close: () => app.close() };
}

test("an invalid registration email is HTTP 400 and a bad refresh id is HTTP 401", async () => {
  const api = await start(["http://app.example"]);
  try {
    const invalid = await fetch(`${api.base}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://app.example" },
      body: JSON.stringify({ email: "not-an-email", password: PASSWORD }),
    });
    assert.equal(invalid.status, 400);
    const body = (await invalid.json()) as { message: string };
    assert.match(body.message, /Email is not valid/);
    const foreign = await fetch(`${api.base}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ email: "owner@example.test", password: PASSWORD }),
    });
    assert.equal(foreign.status, 403);
    const refresh = await fetch(`${api.base}/auth/refresh`, {
      method: "POST",
      headers: {
        cookie: "editagent_refresh=not-a-uuid.secret; editagent_csrf=token",
        "x-editagent-csrf": "token",
      },
    });
    assert.equal(refresh.status, 401);
    const badLogin = await fetch(`${api.base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://app.example" },
      body: JSON.stringify({ email: "not-an-email", password: PASSWORD }),
    });
    const unknownLogin = await fetch(`${api.base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://app.example" },
      body: JSON.stringify({ email: "missing@example.test", password: PASSWORD }),
    });
    assert.equal(badLogin.status, 401);
    assert.equal(unknownLogin.status, 401);
    const badBody = (await badLogin.json()) as { message: string };
    const unknownBody = (await unknownLogin.json()) as { message: string };
    assert.deepEqual(badBody, unknownBody);
    assert.equal(JSON.stringify(badBody).includes("not-an-email"), false);
    assert.equal(JSON.stringify(badBody).toLowerCase().includes("valid"), false);
  } finally {
    await api.close();
  }
});

test("concurrent registration of one email is HTTP 409", async () => {
  const database = "editagent_us118_register_race";
  const adminUrl =
    process.env["DATABASE_URL"] ??
    "postgresql://editagent:editagent-dev-password@127.0.0.1:5432/editagent";
  const admin = new Pool({ connectionString: adminUrl });
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.toString() });
  await applyMigrations(pool);
  const clock = new MutableClock();
  const users = new PostgresUserRepository(pool);
  const sessions = new PostgresRefreshSessionRepository(pool);
  const passwords = new Argon2idHasher();
  const tokens = new JwtSessionTokens(SECRET);
  const rateLimit = new LoginRateLimit(100, 60_000);
  const app = await createApiApplication({
    projects: new PostgresProjectRepository(pool),
    clock,
    ids: new NodeProjectIdGenerator(),
    media: new InMemoryMediaAssetRepository(),
    objects: new MemoryObjectStorage(),
    mediaIds: new NodeMediaAssetIdGenerator(),
    presignTtlSeconds: 900,
    auth: {
      register: new RegisterUser(users, sessions, passwords, tokens, clock, rateLimit),
      login: new LoginUser(users, sessions, passwords, tokens, clock, rateLimit),
      refresh: new RefreshAccess(users, sessions, tokens, clock),
      logout: new LogoutUser(sessions, clock),
      tokens,
      now: () => clock.now(),
      cookieSecure: false,
      trustedOrigins: [],
      trustedProxies: [],
    },
  });
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a port");
  }
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const responses = await Promise.all(
      [0, 1].map(() =>
        fetch(`${base}/auth/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "same@example.test", password: PASSWORD }),
        }),
      ),
    );
    const statuses = responses
      .map((response) => response.status)
      .sort((left, right) => left - right);
    assert.deepEqual(statuses, [201, 409]);
  } finally {
    await app.close();
    await pool.end();
  }
});

function cookieValue(response: Response, name: string): string {
  const header = response.headers.getSetCookie?.().join("\n") ?? "";
  const match = header.match(new RegExp(`${name}=([^;\\n]+)`));
  return decodeURIComponent(match?.[1] ?? "");
}

test("login ignores a planted session, prefers bearer, and does not log secrets", async () => {
  const lines: string[] = [];
  const logger = createServiceLogger(
    "api",
    new Writable({
      write(chunk, _encoding, callback) {
        lines.push(Buffer.from(chunk).toString("utf8"));
        callback();
      },
    }),
  );
  const api = await start([], logger);
  try {
    const planted = "018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f.attacker-secret";
    const owner = await fetch(`${api.base}/auth/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `editagent_refresh=${encodeURIComponent(planted)}; editagent_access=planted-access`,
      },
      body: JSON.stringify({ email: "owner@example.test", password: PASSWORD }),
    });
    assert.equal(owner.status, 201, await owner.clone().text());
    const ownerAccess = cookieValue(owner, "editagent_access");
    const ownerRefresh = cookieValue(owner, "editagent_refresh");
    const ownerCsrf = cookieValue(owner, "editagent_csrf");
    assert.equal(ownerRefresh.includes("attacker-secret"), false);
    assert.equal(ownerAccess.includes("planted-access"), false);
    const other = await fetch(`${api.base}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "other@example.test", password: PASSWORD }),
    });
    assert.equal(other.status, 201, await other.clone().text());
    const otherAccess = cookieValue(other, "editagent_access");
    const created = await fetch(`${api.base}/projects`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${otherAccess}`,
        cookie: `editagent_access=${ownerAccess}; editagent_csrf=${ownerCsrf}`,
        "x-editagent-csrf": ownerCsrf,
      },
      body: JSON.stringify({ name: "Other footage" }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const project = (await created.json()) as { id: string };
    const ownerList = await fetch(`${api.base}/projects`, {
      headers: { cookie: `editagent_access=${ownerAccess}` },
    });
    const ownerBody = await ownerList.text();
    assert.equal(ownerList.status, 200);
    assert.equal(ownerBody.includes("Other footage"), false);
    const stolen = await fetch(`${api.base}/projects/${project.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer not-a-token",
        cookie: `editagent_access=${ownerAccess}; editagent_csrf=${ownerCsrf}`,
        "x-editagent-csrf": ownerCsrf,
      },
      body: JSON.stringify({ name: "Taken" }),
    });
    assert.equal(stolen.status, 401);
    await new Promise<void>((resolve) => {
      logger.flush(() => resolve());
    });
    const log = lines.join("\n");
    assert.equal(log.includes(PASSWORD), false);
    assert.equal(log.includes(ownerAccess), false);
    assert.equal(log.includes(ownerRefresh), false);
    assert.equal(log.includes(ownerCsrf), false);
    assert.equal(log.includes("attacker-secret"), false);
  } finally {
    await api.close();
  }
});

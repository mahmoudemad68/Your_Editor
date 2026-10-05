import { GetCurrentUser } from "./application/current-user.js";
/**
 * Unknown and locked logins perform an Argon2id verification.
 * The measurements are distributions. They are not a constant-time proof.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
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
import { JwtSessionTokens } from "./infrastructure/jwt-session-tokens.js";
import { NodeMediaAssetIdGenerator } from "./infrastructure/node-media-asset-id-generator.js";
import { NodeProjectIdGenerator } from "./infrastructure/node-project-id-generator.js";

const SECRET = "local-development-jwt-secret-32chars";
const PASSWORD = "correct-horse-battery";
const SAMPLES = 30;

class MutableClock implements Clock {
  constructor(private current: Instant) {}

  now(): Instant {
    return this.current;
  }
}

function median(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)] ?? 0;
}

async function elapsed(run: () => Promise<void>): Promise<number> {
  const started = performance.now();
  await run();
  return performance.now() - started;
}

test("unknown and locked logins spend a password verification", async () => {
  const users = new InMemoryUserRepository();
  const sessions = new InMemoryRefreshSessionRepository();
  const clock = new MutableClock(instant(1_700_000_000_000n));
  const passwords = new Argon2idHasher();
  const tokens = new JwtSessionTokens(SECRET);
  const rateLimit = new LoginRateLimit(10_000, 60_000);
  const app = await createApiApplication({
    projects: new InMemoryProjectRepository(),
    clock,
    ids: new NodeProjectIdGenerator(),
    media: new InMemoryMediaAssetRepository(),
    objects: new MemoryObjectStorage(),
    mediaIds: new NodeMediaAssetIdGenerator(),
    presignTtlSeconds: 900,
    auth: {
      currentUser: new GetCurrentUser(users),
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
  const login = async (email: string, password: string): Promise<number> => {
    const status = await elapsed(async () => {
      const response = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      assert.equal(response.status, 401);
      const body = (await response.json()) as { message: string };
      assert.equal(body.message, "Email or password is incorrect.");
      assert.equal(JSON.stringify(body).toLowerCase().includes("lock"), false);
    });
    return status;
  };
  try {
    const registered = await fetch(`${base}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "known@example.test", password: PASSWORD }),
    });
    assert.equal(registered.status, 201);
    const known = await users.findByEmail("known@example.test");
    assert.ok(known);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await users.recordFailedAttempt(known.id, clock.now(), 5, 15n * 60n * 1000n);
    }
    assert.equal((await users.findByEmail("known@example.test"))?.isLocked(clock.now()), true);
    const open = await fetch(`${base}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "open@example.test", password: PASSWORD }),
    });
    assert.equal(open.status, 201);
    for (let warmup = 0; warmup < 3; warmup += 1) {
      await login("missing@example.test", PASSWORD);
      await login("known@example.test", PASSWORD);
      await login("open@example.test", "not-the-password");
      const opener = await users.findByEmail("open@example.test");
      assert.ok(opener);
      await users.clearFailedAttempts(opener.id, clock.now());
    }
    const unknown: number[] = [];
    const locked: number[] = [];
    const wrong: number[] = [];
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      unknown.push(await login("missing@example.test", PASSWORD));
      locked.push(await login("known@example.test", PASSWORD));
      wrong.push(await login("open@example.test", "not-the-password"));
      const opener = await users.findByEmail("open@example.test");
      assert.ok(opener);
      await users.clearFailedAttempts(opener.id, clock.now());
    }
    const summary = {
      unknown: median(unknown),
      locked: median(locked),
      wrong: median(wrong),
    };
    process.stdout.write(`auth-timing medians ${JSON.stringify(summary)}\n`);
    assert.equal((await users.findByEmail("known@example.test"))?.failedLoginCount, 5);
    const slowest = Math.max(summary.unknown, summary.locked, summary.wrong);
    const fastest = Math.min(summary.unknown, summary.locked, summary.wrong);
    assert.ok(fastest >= 5, `verification work was skipped: ${JSON.stringify(summary)}`);
    assert.ok(
      slowest <= fastest * 3,
      `login classes diverged by more than 3x: ${JSON.stringify(summary)}`,
    );
  } finally {
    await app.close();
  }
});

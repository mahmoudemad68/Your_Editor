import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createUuidV7, instant, type Instant, type UserId, userId } from "@editagent/domain";
import {
  AuthRateLimitedError,
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  InvalidRegistrationError,
  LoginUser,
  LogoutUser,
  RefreshAccess,
  RegisterUser,
} from "./authentication.js";
import { type Clock } from "./clock.js";
import { InMemoryRefreshSessionRepository, InMemoryUserRepository } from "./in-memory-identity.js";
import { LoginRateLimit } from "./login-rate-limit.js";
import { type PasswordHasher } from "./password-hasher.js";
import { type IssuedAccessToken, type SessionTokens } from "./session-tokens.js";

const PASSWORD = "correct-horse-battery";

class MutableClock implements Clock {
  constructor(private current: Instant) {}

  now(): Instant {
    return this.current;
  }

  advance(by: bigint): void {
    this.current += by;
  }
}

class FakeHasher implements PasswordHasher {
  burns = 0;
  async hash(password: string): Promise<string> {
    return `$argon2id$test$${createHash("sha256").update(password).digest("hex")}`;
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    return passwordHash === (await this.hash(password));
  }

  async burn(password: string): Promise<void> {
    this.burns += 1;
    await this.verify(await this.hash("not-a-user"), password);
  }
}

class FakeTokens implements SessionTokens {
  async issueAccess(actor: UserId, now: bigint): Promise<IssuedAccessToken> {
    return { token: `access.${actor}.${now.toString()}`, expiresAt: now + 15n * 60n * 1000n };
  }

  async verifyAccess(token: string, _now: bigint): Promise<UserId | null> {
    const id = token.split(".")[1];
    return id === undefined ? null : userId(id);
  }
}

function harness(limit = 20, maxKeys = 10_000) {
  const users = new InMemoryUserRepository();
  const sessions = new InMemoryRefreshSessionRepository();
  const clock = new MutableClock(instant(1_700_000_000_000n));
  const passwords = new FakeHasher();
  const tokens = new FakeTokens();
  const rateLimit = new LoginRateLimit(limit, 60_000, maxKeys);
  return {
    users,
    sessions,
    clock,
    passwords,
    rateLimit,
    register: new RegisterUser(users, sessions, passwords, tokens, clock, rateLimit, () =>
      createUuidV7(1_700_000_000_000, randomBytes(10)),
    ),
    login: new LoginUser(users, sessions, passwords, tokens, clock, rateLimit),
    refresh: new RefreshAccess(users, sessions, tokens, clock),
    logout: new LogoutUser(sessions, clock),
  };
}

test("registration rejects a duplicate email and stores no plaintext password", async () => {
  const { register, users } = harness();
  const created = await register.execute("Owner@Example.test", PASSWORD, "client");
  assert.equal(created.email, "owner@example.test");
  const stored = await users.findByEmail("owner@example.test");
  assert.ok(stored);
  assert.equal(stored.passwordHash.startsWith("$argon2id$"), true);
  assert.equal(stored.passwordHash.includes(PASSWORD), false);
  await assert.rejects(
    () => register.execute("owner@example.test", PASSWORD, "client"),
    EmailAlreadyRegisteredError,
  );
  await assert.rejects(
    () => register.execute("nope", PASSWORD, "client"),
    InvalidRegistrationError,
  );
});

test("login failures lock the account without a distinct error", async () => {
  const { register, login, users, clock } = harness();
  await register.execute("owner@example.test", PASSWORD, "client");
  await assert.rejects(
    () => login.execute("missing@example.test", PASSWORD, "client"),
    InvalidCredentialsError,
  );
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      () => login.execute("owner@example.test", "not-the-password", "client"),
      (error: unknown) => {
        assert.ok(error instanceof InvalidCredentialsError);
        assert.equal(error.message, "Email or password is incorrect.");
        assert.equal(error.message.toLowerCase().includes("lock"), false);
        return true;
      },
    );
  }
  const locked = await users.findByEmail("owner@example.test");
  assert.equal(locked?.failedLoginCount, 5);
  assert.equal(locked?.isLocked(clock.now()), true);
  await assert.rejects(
    () => login.execute("owner@example.test", PASSWORD, "client"),
    InvalidCredentialsError,
  );
  assert.equal((await users.findByEmail("owner@example.test"))?.failedLoginCount, 5);
  clock.advance(15n * 60n * 1000n + 1n);
  const signedIn = await login.execute("owner@example.test", PASSWORD, "client");
  assert.equal(signedIn.email, "owner@example.test");
  assert.equal((await users.findByEmail("owner@example.test"))?.failedLoginCount, 0);
});

test("a reused refresh token revokes every session for that account", async () => {
  const { register, refresh, logout, sessions, clock } = harness();
  const first = await register.execute("owner@example.test", PASSWORD, "client");
  clock.advance(1_000n);
  const rotated = await refresh.execute(first.refreshToken);
  assert.notEqual(rotated.refreshToken, first.refreshToken);
  assert.notEqual(rotated.accessToken, first.accessToken);
  await assert.rejects(() => refresh.execute(first.refreshToken), InvalidCredentialsError);
  await assert.rejects(() => refresh.execute(rotated.refreshToken), InvalidCredentialsError);
  const current = rotated.refreshToken.slice(0, rotated.refreshToken.indexOf("."));
  assert.equal((await sessions.findById(current))?.isActive(1_700_000_000_000n), false);
  await logout.execute(rotated.refreshToken);
});

test("one refresh token cannot be consumed twice in the same process", async () => {
  const { register, refresh, sessions } = harness();
  const first = await register.execute("owner@example.test", PASSWORD, "client");
  const results = await Promise.allSettled([
    refresh.execute(first.refreshToken),
    refresh.execute(first.refreshToken),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const presented = first.refreshToken.slice(0, first.refreshToken.indexOf("."));
  assert.notEqual((await sessions.findById(presented))?.revokedAt, null);
  const fulfilled = results.find((result) => result.status === "fulfilled");
  if (fulfilled?.status === "fulfilled") {
    const next = fulfilled.value.refreshToken.slice(0, fulfilled.value.refreshToken.indexOf("."));
    assert.notEqual((await sessions.findById(next))?.revokedAt, null);
  }
});

test("a refresh id that is not a uuid never reaches the session store", async () => {
  const users = new InMemoryUserRepository();
  const sessions = new InMemoryRefreshSessionRepository();
  const clock = new MutableClock(instant(1_700_000_000_000n));
  let queried = false;
  const guarded = new Proxy(sessions, {
    get(target, property, receiver) {
      if (property === "rotate" || property === "findById" || property === "endSession") {
        return () => {
          queried = true;
          throw new Error("persistence was queried");
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const refresh = new RefreshAccess(users, guarded, new FakeTokens(), clock);
  await assert.rejects(() => refresh.execute("not-a-uuid.secret"), InvalidCredentialsError);
  assert.equal(queried, false);
});

test("registration scopes normalized identities and isolates unrelated users", async () => {
  const { register } = harness(1);
  await register.execute("owner@example.test", PASSWORD, "client");
  await assert.rejects(
    () => register.execute(" Owner@Example.test ", PASSWORD, "client"),
    AuthRateLimitedError,
  );
  assert.equal(
    (await register.execute("other@example.test", PASSWORD, "client")).email,
    "other@example.test",
  );
});

test("login normalization, endpoint and network scopes preserve credential protection", async () => {
  const { register, login, passwords } = harness(2);
  await register.execute("victim@example.test", PASSWORD, "bff");
  for (const email of ["Attacker@Example.test", " attacker@example.test "]) {
    await assert.rejects(() => login.execute(email, PASSWORD, "bff"), InvalidCredentialsError);
  }
  assert.equal(passwords.burns, 2);
  await assert.rejects(
    () => login.execute("attacker@example.test", PASSWORD, "bff"),
    AuthRateLimitedError,
  );
  assert.equal(passwords.burns, 2); // Throttled requests do not reach the hasher.
  assert.equal(
    (await login.execute("victim@example.test", PASSWORD, "bff")).email,
    "victim@example.test",
  );
  assert.equal(
    (await register.execute("new@example.test", PASSWORD, "bff")).email,
    "new@example.test",
  );
  // Same identity has an independent registration budget; account existence never defines the key.
  await register.execute("attacker@example.test", PASSWORD, "bff");
  await assert.rejects(
    () => login.execute("attacker@example.test", PASSWORD, "bff"),
    AuthRateLimitedError,
  );
  assert.equal(
    (await login.execute("attacker@example.test", PASSWORD, "direct-client")).email,
    "attacker@example.test",
  );
});

test("keys hash normalized email and malformed spellings share one bounded bucket", async () => {
  const { register, login, rateLimit } = harness(1);
  const keys: string[] = [];
  const allow = rateLimit.allow.bind(rateLimit);
  rateLimit.allow = (key, now) => {
    keys.push(key);
    return allow(key, now);
  };
  await assert.rejects(
    () => login.execute(" Unknown@Example.test ", PASSWORD, "bff"),
    InvalidCredentialsError,
  );
  await assert.rejects(
    () => login.execute("unknown@example.test", PASSWORD, "bff"),
    AuthRateLimitedError,
  );
  const digest = createHash("sha256").update("unknown@example.test").digest("hex");
  assert.deepEqual(keys, [`login:bff:sha256:${digest}`, `login:bff:sha256:${digest}`]);
  await assert.rejects(
    () => login.execute("not-an-email", PASSWORD, "bff"),
    InvalidCredentialsError,
  );
  await assert.rejects(
    () => login.execute("different-invalid-input", PASSWORD, "bff"),
    AuthRateLimitedError,
  );
  await assert.rejects(
    () => register.execute("invalid", PASSWORD, "bff"),
    InvalidRegistrationError,
  );
  await assert.rejects(
    () => register.execute("other-invalid", PASSWORD, "bff"),
    AuthRateLimitedError,
  );
  assert.deepEqual(keys.slice(2), [
    "login:bff:malformed-email",
    "login:bff:malformed-email",
    "register:bff:malformed-email",
    "register:bff:malformed-email",
  ]);
});

test("key-space exhaustion admits unrelated users without evicting persistent account lockout", async () => {
  const { register, login, users, clock, rateLimit } = harness(30, 2);
  await register.execute("victim@example.test", PASSWORD, "bff");
  for (let i = 0; i < 5; i++) {
    await assert.rejects(
      () => login.execute("victim@example.test", "wrong-password", `peer-${i}`),
      InvalidCredentialsError,
    );
  }
  for (let i = 0; i < 100; i++) {
    await assert.rejects(
      () => login.execute(`noise-${i}@example.test`, PASSWORD, "bff"),
      InvalidCredentialsError,
    );
    assert.ok(rateLimit.size() <= 2);
  }
  assert.equal((await users.findByEmail("victim@example.test"))?.isLocked(clock.now()), true);
  await assert.rejects(
    () => login.execute("victim@example.test", PASSWORD, "bff"),
    InvalidCredentialsError,
  );
  await register.execute("unrelated@example.test", PASSWORD, "bff");
  assert.equal(
    (await login.execute("unrelated@example.test", PASSWORD, "bff")).email,
    "unrelated@example.test",
  );
  assert.equal(rateLimit.size(), 2);
});

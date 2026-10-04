import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainError } from "../../kernel/error.js";
import { userId } from "../../kernel/id.js";
import { User } from "./user.js";

const ID = userId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f");

const HASH = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$abcdefghijklmnopqrstuvwxyz0123456789";

test("User restore keeps the operator role and distinct audit timestamps", () => {
  const user = User.restore({
    id: ID,
    email: "Owner@Example.test",
    passwordHash: HASH,
    operatorRole: "admin",
    failedLoginCount: 0,
    lockedUntil: null,
    createdAt: 10n,
    updatedAt: 40n,
  });
  assert.equal(user.email, "owner@example.test");
  assert.equal(user.passwordHash.startsWith("$argon2id$"), true);
  assert.equal(user.isAdmin(), true);
  assert.equal(user.createdAt, 10n);
  assert.equal(user.updatedAt, 40n);
  assert.deepEqual(User.restore(user.toSnapshot()).toSnapshot(), user.toSnapshot());
  assert.throws(() => new User(ID, "owner@example.test", HASH, "owner", 10n, 40n), DomainError);
  assert.throws(() => new User(ID, "owner@example.test", HASH, null, -1n, 40n));
  assert.throws(
    () => new User(ID, "owner@example.test", HASH, null, 10n, 9n),
    /createdAt must be less than/,
  );
  assert.throws(
    () =>
      User.restore({
        id: ID,
        email: "owner@example.test",
        passwordHash: HASH,
        operatorRole: null,
        failedLoginCount: 0,
        lockedUntil: null,
        createdAt: "10",
        updatedAt: "9",
      }),
    /createdAt must be less than/,
  );
  assert.throws(() => new User(ID, "owner@example.test", "plaintext", null, 10n, 10n), /argon2id/);
});

test("failed logins lock the account and a success clears the lock", () => {
  const user = User.create(ID, "owner@example.test", HASH, 10n);
  const failed = user.recordFailedLogin(20n, 2, 100n);
  assert.equal(failed.isLocked(50n), false);
  const locked = failed.recordFailedLogin(30n, 2, 100n);
  assert.equal(locked.isLocked(50n), true);
  assert.equal(locked.isLocked(130n), false);
  const cleared = locked.clearFailedLogins(40n);
  assert.equal(cleared.failedLoginCount, 0);
  assert.equal(cleared.lockedUntil, null);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainError } from "../../kernel/error.js";
import { userId } from "../../kernel/id.js";
import { User } from "./user.js";

const ID = userId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f");

test("User restore keeps the operator role and distinct audit timestamps", () => {
  const user = User.restore({
    id: ID,
    operatorRole: "admin",
    createdAt: 10n,
    updatedAt: 40n,
  });
  assert.equal(user.isAdmin(), true);
  assert.equal(user.createdAt, 10n);
  assert.equal(user.updatedAt, 40n);
  assert.deepEqual(User.restore(user.toSnapshot()).toSnapshot(), user.toSnapshot());
  assert.throws(() => new User(ID, "owner", 10n, 40n), DomainError);
  assert.throws(() => new User(ID, null, -1n, 40n));
});

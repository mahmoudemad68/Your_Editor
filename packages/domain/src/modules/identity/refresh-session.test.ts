import assert from "node:assert/strict";
import { test } from "node:test";
import { userId } from "../../kernel/id.js";
import { RefreshSession } from "./refresh-session.js";

const ID = "018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f";
const OWNER = userId("018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f");
const HASH = "a".repeat(64);

test("a refresh session expires and revocation is permanent", () => {
  const session = RefreshSession.issue(ID, OWNER, HASH, 10n, 100n);
  assert.equal(session.isActive(50n), true);
  assert.equal(session.isActive(100n), false);
  const revoked = session.revoke(40n);
  assert.equal(revoked.isActive(50n), false);
  assert.equal(revoked.revoke(60n), revoked);
  const clamped = session.revoke(1n);
  assert.equal(clamped.revokedAt, session.createdAt);
  assert.equal(clamped.isActive(50n), false);
  assert.equal(clamped.revoke(2n), clamped);
  assert.deepEqual(RefreshSession.restore(revoked.toSnapshot()).toSnapshot(), revoked.toSnapshot());
});

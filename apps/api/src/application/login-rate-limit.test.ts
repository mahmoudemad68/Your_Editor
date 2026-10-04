import assert from "node:assert/strict";
import { test } from "node:test";
import { LoginRateLimit } from "./login-rate-limit.js";

test("the credential limit counts hits inside the window and forgets older ones", () => {
  const limit = new LoginRateLimit(2, 1_000);
  assert.equal(limit.allow("client", 1_000), true);
  assert.equal(limit.allow("client", 1_100), true);
  assert.equal(limit.allow("client", 1_200), false);
  assert.equal(limit.allow("other", 1_200), true);
  assert.equal(limit.allow("client", 2_001), true);
});

test("expired client keys are dropped and new keys stop at the cap", () => {
  const limit = new LoginRateLimit(1, 1_000, 2);
  assert.equal(limit.allow("a", 1_000), true);
  assert.equal(limit.allow("b", 1_000), true);
  assert.equal(limit.allow("c", 1_000), false);
  assert.equal(limit.size(), 2);
  assert.equal(limit.allow("a", 2_100), true);
  assert.equal(limit.size(), 1);
  assert.equal(limit.allow("c", 2_100), true);
  assert.equal(limit.size(), 2);
});

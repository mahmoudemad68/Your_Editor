import assert from "node:assert/strict";
import { test } from "node:test";
import { credentialErrors, safeReturnTo } from "./auth-validation";

test("credentials match backend email/password limits", () => {
  for (const email of [
    "a@b..com",
    "a@b",
    "a@b.c",
    "a b@example.com",
    "x@-bad.example",
    "x@bad-.example",
    "",
    `${"a".repeat(250)}@example.com`,
  ]) {
    assert.ok(credentialErrors(email, "x".repeat(12)).email, email);
  }
  assert.deepEqual(credentialErrors(" Owner@Example.test ", "x".repeat(12)), {});
  assert.deepEqual(credentialErrors("a@example.test", "x".repeat(200)), {});
  assert.ok(credentialErrors("a@example.test", "x".repeat(11)).password);
  assert.ok(credentialErrors("a@example.test", "x".repeat(201)).password);
});

test("return targets are restricted to internal application routes", () => {
  const project = "/projects/018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4f?tab=media#details";
  assert.equal(safeReturnTo(project), project);
  for (const value of [
    null,
    "https://evil.example",
    "//evil.example",
    "javascript:alert(1)",
    "/\\evil.example",
    "/%5cevil.example",
    "/%0devil.example",
    "/%zz",
    "/sign-in",
    "/auth/logout",
    "/projects/not-an-id",
    "https:%2f%2fevil.example",
  ])
    assert.equal(safeReturnTo(value), "/");
});

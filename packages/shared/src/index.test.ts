import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError, productName } from "./index.js";

test("product name is stable", () => {
  assert.equal(productName, "EditAgent");
});

test("AppError carries a code", () => {
  const error = new AppError("scaffold", "not implemented");
  assert.equal(error.code, "scaffold");
  assert.equal(error.name, "AppError");
});

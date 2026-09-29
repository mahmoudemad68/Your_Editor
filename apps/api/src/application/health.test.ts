import assert from "node:assert/strict";
import { test } from "node:test";
import { getHealthStatus } from "./health.js";

test("health reports the bounded module count", () => {
  const status = getHealthStatus();
  assert.equal(status.status, "ok");
  assert.equal(status.modules, 12);
});

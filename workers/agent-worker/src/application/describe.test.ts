import assert from "node:assert/strict";
import { test } from "node:test";
import { describeWorker } from "./describe.js";

test("agent worker describes itself", () => {
  assert.equal(describeWorker(), "EditAgent agent-worker");
});

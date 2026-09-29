import assert from "node:assert/strict";
import { test } from "node:test";
import { describeWorker } from "./describe.js";

test("media worker describes itself", () => {
  assert.equal(describeWorker(), "EditAgent media-worker");
});

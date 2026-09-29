import assert from "node:assert/strict";
import { test } from "node:test";
import { mediaTimeSchema, workerHealthSchema } from "./index.js";

test("media time schema is a canonical integer string", () => {
  assert.equal(mediaTimeSchema.pattern, "^(0|[1-9][0-9]*)$");
  assert.equal(mediaTimeSchema.type, "string");
});

test("worker health schema requires worker and status", () => {
  assert.deepEqual(workerHealthSchema.required, ["worker", "status"]);
});

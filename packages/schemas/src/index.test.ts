import assert from "node:assert/strict";
import { test } from "node:test";
import { jobEnvelopeSchema, mediaTimeSchema, workerHealthSchema } from "./index.js";

test("media time schema is a canonical integer string", () => {
  assert.equal(mediaTimeSchema.pattern, "^(0|[1-9][0-9]*)$");
  assert.equal(mediaTimeSchema.type, "string");
});

test("worker health schema requires worker and status", () => {
  assert.deepEqual(workerHealthSchema.required, ["worker", "status"]);
});

test("job envelope schema is version 1 and rejects extra fields", () => {
  assert.equal(jobEnvelopeSchema.properties.schemaVersion.const, 1);
  assert.equal(jobEnvelopeSchema.additionalProperties, false);
  assert.ok(jobEnvelopeSchema.required.includes("idempotencyKey"));
  assert.ok(jobEnvelopeSchema.required.includes("attempt"));
});

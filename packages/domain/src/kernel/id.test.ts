import assert from "node:assert/strict";
import { test } from "vitest";
import { DomainError } from "./error.js";
import { createUuidV7, userId, uuidV7 } from "./id.js";

const SAMPLE = "018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f";

test("uuidV7 accepts a canonical version-7 UUID", () => {
  assert.equal(uuidV7(SAMPLE), SAMPLE);
  assert.throws(() => uuidV7(SAMPLE.toUpperCase()));
  assert.throws(() => uuidV7(SAMPLE.replace("a", "A")));
});

test("uuidV7 rejects other versions and malformed strings", () => {
  assert.throws(() => uuidV7("018f6b6e-7c3a-4b2a-8d3e-9c0b1a2d3e4f"), DomainError);
  assert.throws(() => uuidV7("not-a-uuid"), DomainError);
  assert.throws(() => userId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f".slice(0, -1)), DomainError);
});

test("createUuidV7 sets the version and variant bits", () => {
  const entropy = new Uint8Array(10).fill(0xab);
  const id = createUuidV7(1_700_000_000_000, entropy);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.throws(() => createUuidV7(-1, entropy), DomainError);
  assert.throws(() => createUuidV7(0, new Uint8Array(9)), DomainError);
});

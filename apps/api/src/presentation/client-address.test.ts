import assert from "node:assert/strict";
import { test } from "node:test";
import { clientAddress } from "./client-address.js";

test("a direct client cannot choose its address with X-Forwarded-For", () => {
  assert.equal(clientAddress("127.0.0.1", "203.0.113.5", []), "127.0.0.1");
  assert.equal(
    clientAddress("::ffff:127.0.0.1", "203.0.113.5, 10.0.0.8", ["10.0.0.8"]),
    "127.0.0.1",
  );
});

test("a trusted proxy contributes the nearest untrusted forwarded address", () => {
  assert.equal(clientAddress("10.0.0.8", "203.0.113.5, 10.0.0.8", ["10.0.0.8"]), "203.0.113.5");
  assert.equal(clientAddress("10.0.0.8", undefined, ["10.0.0.8"]), "10.0.0.8");
  assert.equal(
    clientAddress("10.0.0.8", "10.0.0.8, 203.0.113.4, 10.1.0.2, 10.0.0.8", [
      "10.0.0.8",
      "10.1.0.2",
    ]),
    "203.0.113.4",
  );
});

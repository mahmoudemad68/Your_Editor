import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Pool } from "pg";

import { observePostgresPool } from "./readiness.js";

test("an idle Postgres disconnect is handled on the pool", () => {
  const emitter = new EventEmitter();
  const seen: string[] = [];
  observePostgresPool(emitter as unknown as Pool, (error) => {
    seen.push(error.message);
  });
  emitter.emit("error", new Error("Connection terminated unexpectedly"));
  assert.deepEqual(seen, ["Connection terminated unexpectedly"]);
});

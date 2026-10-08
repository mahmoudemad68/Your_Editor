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

test("readiness removes its checked-out listener on a client error before destroying it", async () => {
  const { postgresAndRedisReady } = await import("./readiness.js");
  const client = new EventEmitter();
  const releases: boolean[] = [];
  const fakeClient = Object.assign(client, {
    query: () =>
      new Promise((_resolve, reject) => {
        setImmediate(() => {
          assert.equal(client.listenerCount("error"), 1);
          client.emit("error", new Error("dependency failure"));
          reject(new Error("query failed"));
        });
      }),
    release: (destroy: boolean) => {
      assert.equal(client.listenerCount("error"), 0);
      releases.push(destroy);
    },
  });
  const pool = { connect: async () => fakeClient } as unknown as Pool;
  assert.equal(await postgresAndRedisReady(pool, "redis://127.0.0.1:1"), false);
  assert.deepEqual(releases, [true]);
});

test("readiness destroys a query-timeout client and removes the temporary listener", async () => {
  const { postgresAndRedisReady, READINESS_DEADLINE_MS } = await import("./readiness.js");
  const client = new EventEmitter();
  const releases: boolean[] = [];
  const fakeClient = Object.assign(client, {
    query: () => new Promise(() => undefined),
    release: (destroy: boolean) => {
      assert.equal(client.listenerCount("error"), 0);
      releases.push(destroy);
    },
  });
  const started = Date.now();
  assert.equal(
    await postgresAndRedisReady({ connect: async () => fakeClient } as unknown as Pool, "unused"),
    false,
  );
  assert.ok(Date.now() - started < READINESS_DEADLINE_MS + 500);
  assert.deepEqual(releases, [true]);
});

test("a connection resolving after the readiness deadline is destroyed exactly once", async () => {
  const { postgresAndRedisReady, READINESS_DEADLINE_MS } = await import("./readiness.js");
  const releases: boolean[] = [];
  const client = Object.assign(new EventEmitter(), {
    release: (destroy: boolean) => releases.push(destroy),
  });
  let resolve!: (value: typeof client) => void;
  const pending = new Promise<typeof client>((done) => {
    resolve = done;
  });
  const started = Date.now();
  assert.equal(
    await postgresAndRedisReady({ connect: () => pending } as unknown as Pool, "unused"),
    false,
  );
  assert.ok(Date.now() - started < READINESS_DEADLINE_MS + 500);
  resolve(client);
  await new Promise<void>((done) => setImmediate(done));
  assert.deepEqual(releases, [true]);
  assert.equal(client.listenerCount("error"), 0);
});

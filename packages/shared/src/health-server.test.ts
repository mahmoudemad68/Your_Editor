import assert from "node:assert/strict";
import { type Server } from "node:http";
import { test } from "node:test";

import { startHealthServer } from "./health-server.js";

test("worker health and ready endpoints answer on the process port", async () => {
  const server = await listen(0);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP port");
  }
  try {
    const health = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    const ready = await fetch(`http://127.0.0.1:${address.port}/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: "ready" });
  } finally {
    server.close();
  }
});

function listen(port: number): Promise<Server> {
  const server = startHealthServer(port);
  return new Promise((resolve, reject) => {
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

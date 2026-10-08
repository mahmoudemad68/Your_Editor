import assert from "node:assert/strict";
import { type Server } from "node:http";
import { test } from "node:test";

import { startHealthServer } from "./health-server.js";

test("worker /health is liveness and /ready follows the dependency probe", async () => {
  const unready = await listen(0);
  const ready = await listen(0, { ready: () => true });
  const down = await listen(0, { ready: () => false });
  try {
    await expectStatus(unready, "/health", 200, { status: "ok" });
    await expectStatus(unready, "/ready", 503, { status: "not-ready" });
    await expectStatus(ready, "/health", 200, { status: "ok" });
    await expectStatus(ready, "/ready", 200, { status: "ready" });
    await expectStatus(down, "/health", 200, { status: "ok" });
    await expectStatus(down, "/ready", 503, { status: "not-ready" });
  } finally {
    unready.close();
    ready.close();
    down.close();
  }
});

async function expectStatus(
  server: Server,
  path: string,
  status: number,
  body: { status: string },
): Promise<void> {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP port");
  }
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), body);
}

function listen(port: number, options?: { ready: () => boolean }): Promise<Server> {
  const server = options === undefined ? startHealthServer(port) : startHealthServer(port, options);
  return new Promise((resolve, reject) => {
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

test("a synchronous readiness failure returns 503 while liveness remains healthy", async () => {
  const server = await listen(0, {
    ready: () => {
      throw new Error("private dependency detail");
    },
  });
  try {
    await expectStatus(server, "/ready", 503, { status: "not-ready" });
    await expectStatus(server, "/health", 200, { status: "ok" });
  } finally {
    server.close();
  }
});

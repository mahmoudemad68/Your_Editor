import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { apiDependenciesReady } from "./api-readiness";

test("web readiness checks the API and bounds a non-answering connection", async () => {
  let mode: "ready" | "down" | "silent" = "ready";
  const server = createServer((_request, response) => {
    if (mode === "silent") return;
    response.writeHead(mode === "ready" ? 200 : 503);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const original = process.env["API_BASE_URL"];
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env["API_BASE_URL"] = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal(await apiDependenciesReady(), true);
    mode = "down";
    assert.equal(await apiDependenciesReady(), false);
    mode = "silent";
    const started = Date.now();
    assert.equal(await apiDependenciesReady(), false);
    assert.ok(Date.now() - started < 3000);
  } finally {
    if (original === undefined) delete process.env["API_BASE_URL"];
    else process.env["API_BASE_URL"] = original;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

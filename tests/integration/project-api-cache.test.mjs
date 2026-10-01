import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";

const serverPath = path.resolve("apps/web/.next/standalone/apps/web/server.js");

test("same-origin project routes send private no-store, including 401", async () => {
  let mode = "deny";
  const upstream = http.createServer((request, response) => {
    request.resume();
    if (mode === "allow" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ projects: [] }));
      return;
    }
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ statusCode: 401, message: "Sign in is required." }));
  });
  await listen(upstream);
  const apiAddress = upstream.address();
  if (apiAddress === null || typeof apiAddress === "string") {
    throw new Error("upstream did not bind a port");
  }
  const apiPort = apiAddress.port;
  const webPort = await freePort();
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      API_BASE_URL: `http://127.0.0.1:${apiPort}`,
      PORT: String(webPort),
      HOSTNAME: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout?.on("data", (chunk) => {
    logs += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    logs += chunk.toString();
  });
  try {
    await waitForHttp(`http://127.0.0.1:${webPort}/`);
    const denied = [
      ["GET", "/api/projects"],
      ["POST", "/api/projects"],
      ["PATCH", "/api/projects/018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f"],
      ["DELETE", "/api/projects/018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f"],
      ["POST", "/api/projects/018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f/uploads"],
      ["POST", "/api/projects/018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f/uploads/complete"],
      [
        "GET",
        "/api/projects/018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f/media/018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4f",
      ],
    ];
    for (const [method, pathname] of denied) {
      const response = await fetch(`http://127.0.0.1:${webPort}${pathname}`, {
        method,
        headers: { "content-type": "application/json" },
        body:
          method === "GET" || method === "DELETE"
            ? undefined
            : JSON.stringify(
                pathname.includes("/uploads")
                  ? {
                      filename: "clip.mp4",
                      mimeType: "video/mp4",
                      byteSize: 3,
                      sha256: "ab".repeat(32),
                    }
                  : { name: "Cut" },
              ),
      });
      assert.equal(response.status, 200, `${method} ${logs}`);
      assert.equal(response.headers.get("cache-control"), "private, no-store", method);
      const body = await response.json();
      assert.equal(body.ok, false, method);
      assert.equal(body.status, 401, method);
      assert.equal(body.message, "Sign in is required.");
    }

    mode = "allow";
    const listed = await fetch(`http://127.0.0.1:${webPort}/api/projects`);
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await listed.json(), { ok: true, data: [] });
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => undefined);
    upstream.close();
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForHttp(url) {
  const started = Date.now();
  let last = "not started";
  while (Date.now() - started < 20000) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      last = String(response.status);
    } catch (error) {
      last = error instanceof Error ? error.message : "unreachable";
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`web server did not start (${last})`);
}

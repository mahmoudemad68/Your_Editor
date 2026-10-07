import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const web = path.join(root, "apps/web");
const require = createRequire(path.join(web, "package.json"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(5);
  }
  throw new Error("Process/stream condition did not arrive.");
}
function child(args, cwd, observe = false) {
  if (observe) args = ["--import", path.join(root, "tests/e2e/process-exit-observer.mjs"), ...args];
  const process = spawn(globalThis.process.execPath, args, {
    cwd,
    env: {
      ...globalThis.process.env,
      API_BASE_URL: "http://127.0.0.1:3031",
      PORT: "3030",
      HOSTNAME: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  process.stdout.on("data", (chunk) => {
    output += chunk;
  });
  process.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = once(process, "exit");
  return { process, exited, output: () => output };
}
async function ready(url) {
  await until(
    () =>
      fetch(url, { signal: globalThis.AbortSignal.timeout(1000) })
        .then((r) => r.ok)
        .catch(() => false),
    Boolean,
  );
}
const control = async () => (await fetch("http://127.0.0.1:3032/job-transport-state")).json();
function connect(project, cookie) {
  return new Promise((resolve, reject) => {
    const req = request(
      `http://127.0.0.1:3030/api/projects/${project}/jobs/events`,
      { headers: { cookie } },
      (res) => {
        assert.equal(res.statusCode, 200);
        res.resume();
        resolve({
          req,
          res,
          close() {
            res.destroy();
            req.destroy();
          },
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}
test(
  "real next start and Docker standalone layout SIGTERM abort all authenticated BFF streams",
  { timeout: 90000 },
  async () => {
    const api = child([path.join(root, "tests/e2e/us119-api.mjs")], root);
    const evidence = [];
    try {
      await ready("http://127.0.0.1:3032/health");
      assert.equal(
        (await fetch("http://127.0.0.1:3032/reset", { method: "POST", body: '{"jobs":true}' }))
          .status,
        200,
      );
      const registered = await fetch("http://127.0.0.1:3031/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:3030" },
        body: JSON.stringify({ email: "shutdown@example.test", password: "correct-horse-battery" }),
      });
      assert.equal(registered.status, 201);
      const cookie = registered.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const csrf = cookie.match(/editagent_csrf=([^;]+)/)[1];
      const projects = [];
      for (const name of ["Shutdown A", "Shutdown B"]) {
        const response = await fetch("http://127.0.0.1:3031/projects", {
          method: "POST",
          headers: { cookie, "x-editagent-csrf": csrf, "content-type": "application/json" },
          body: JSON.stringify({ name }),
        });
        assert.equal(response.status, 201);
        projects.push((await response.json()).id);
      }
      for (const mode of ["next-start", "standalone"]) {
        for (const streamCount of [1, 3]) {
          const server = child(
            mode === "next-start"
              ? [
                  require.resolve("next/dist/bin/next"),
                  "start",
                  "--hostname",
                  "127.0.0.1",
                  "--port",
                  "3030",
                ]
              : [path.join(web, ".next/standalone/apps/web/server.js")],
            web,
            true,
          );
          const streams = [];
          try {
            await ready("http://127.0.0.1:3030/health");
            const normal = await connect(projects[0], cookie);
            await until(control, (state) => state.subscriptions === 1);
            const normalAt = performance.now();
            normal.close();
            await until(control, (state) => state.subscriptions === 0 && state.redisChannels === 0);
            const normalReleaseMs = performance.now() - normalAt;
            for (const project of [projects[0], projects[0], projects[1]].slice(0, streamCount))
              streams.push(await connect(project, cookie));
            await until(control, (state) => state.subscriptions === streamCount);
            const signalAt = performance.now();
            server.process.kill("SIGTERM");
            const released = until(
              control,
              (state) => state.subscriptions === 0 && state.redisChannels === 0,
            ).then(() => performance.now() - signalAt);
            const [code] = await Promise.race([
              server.exited,
              delay(5000).then(() => {
                throw new Error(`${mode} did not exit within 5 seconds: ${server.output()}`);
              }),
            ]);
            const exitMs = performance.now() - signalAt;
            const upstreamReleaseMs = await released;
            assert.equal(code, 143, "Next retains its own normal signal shutdown");
            assert.ok(exitMs <= 5000);
            assert.match(
              server.output(),
              new RegExp('"abortedStreams":' + streamCount + ',"activeStreams":0'),
            );
            assert.match(
              server.output(),
              /"sigtermListeners":2,"sigintListeners":2,"activeStreams":0/,
            );
            await until(async () => streams.every(({ res }) => res.destroyed), Boolean);
            const established = readFileSync("/proc/net/tcp", "utf8")
              .split("\n")
              .filter((line) => {
                const fields = line.trim().split(/\s+/);
                return fields[1]?.endsWith(":0BD6") && fields[3] === "01";
              }).length;
            assert.equal(established, 0, "no established server socket survives process exit");
            evidence.push({
              mode,
              streamsBefore: streamCount,
              streamsAfter: 0,
              exitMs,
              upstreamReleaseMs,
              normalReleaseMs,
              establishedSocketsAfter: established,
            });
          } finally {
            for (const stream of streams) stream.close();
            if (server.process.exitCode === null) {
              server.process.kill("SIGTERM");
              await server.exited;
            }
          }
        }
      }
      console.log("US131_SHUTDOWN_EVIDENCE", JSON.stringify(evidence));
    } finally {
      await fetch("http://127.0.0.1:3032/reset", { method: "POST" }).catch(() => {});
      api.process.kill("SIGTERM");
      await api.exited;
    }
  },
);

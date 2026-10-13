import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { randomBytes } from "node:crypto";
import { clearTimeout } from "node:timers";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const web = path.join(root, "apps/web");
const require = createRequire(path.join(web, "package.json"));
const apiRequire = createRequire(path.join(root, "apps/api/package.json"));
const { createUuidV7 } = apiRequire("@editagent/domain");
const { RedisJobEventSubscriber, projectJobChannel } = apiRequire("@editagent/job-queue");
const { Redis } = apiRequire("ioredis");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, predicate, timeout = 10000, phase = "process/stream") {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    const value = await read();
    last = value;
    if (predicate(value)) return value;
    await delay(5);
  }
  throw new Error(`${phase} condition did not arrive; last observation: ${JSON.stringify(last)}`);
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
  return {
    process,
    exited,
    output: () => output,
    diagnostic: () => ({
      exitCode: process.exitCode,
      signal: process.signalCode,
      errorCodes: [
        ...new Set(
          output.match(
            /\b(?:EADDRINUSE|ECONNREFUSED|ENOENT|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND)\b/g,
          ) ?? [],
        ),
      ],
    }),
  };
}
async function ready(url) {
  await until(
    () =>
      fetch(url, { signal: globalThis.AbortSignal.timeout(1000) })
        .then((r) => r.ok)
        .catch(() => false),
    Boolean,
    10000,
    `startup ${new URL(url).host}${new URL(url).pathname}`,
  );
}
const control = async () =>
  (
    await fetch("http://127.0.0.1:3032/job-transport-state", {
      signal: globalThis.AbortSignal.timeout(1000),
    })
  ).json();
function connect(project, cookie) {
  return new Promise((resolve, reject) => {
    let response,
      settled = false,
      text = "";
    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      response?.destroy();
      req.destroy();
      reject(new Error(message));
    };
    const watchdog = setTimeout(() => fail("SSE connected-frame handshake did not arrive."), 10000);
    const req = request(
      `http://127.0.0.1:3030/api/projects/${project}/jobs/events`,
      { headers: { cookie } },
      (res) => {
        response = res;
        if (
          res.statusCode !== 200 ||
          !res.headers["content-type"]?.startsWith("text/event-stream")
        ) {
          fail(`SSE handshake rejected (HTTP ${res.statusCode}).`);
          return;
        }
        // HTTP headers alone do not prove the byte-stream path is established.
        // This real API comment is sent only after Redis SUBSCRIBE acknowledges.
        const connected = (chunk) => {
          text += chunk.toString("utf8");
          if (text.length > 65536) return fail("SSE handshake exceeded its byte bound.");
          if (!text.includes(": connected; live delivery only\n\n")) return;
          settled = true;
          clearTimeout(watchdog);
          res.removeListener("data", connected);
          res.resume();
          resolve({
            req,
            res,
            close() {
              res.destroy();
              req.destroy();
            },
          });
        };
        res.on("data", connected);
        res.once("end", () => fail("SSE ended before its connected-frame handshake."));
        res.on("error", () => fail("SSE connection failed before its handshake."));
      },
    );
    req.on("error", () => fail("SSE request failed before its handshake."));
    req.end();
  });
}
test(
  "real next start and Docker standalone layout SIGTERM abort all authenticated BFF streams",
  { timeout: 90000 },
  async () => {
    const api = child([path.join(root, "tests/e2e/us119-api.mjs")], root);
    const evidence = [];
    const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379/0";
    const foreign = new RedisJobEventSubscriber(redisUrl);
    const monitor = new Redis(redisUrl);
    const foreignProject = createUuidV7(Date.now(), randomBytes(10));
    let foreignSubscription;
    const assertForeignActive = async () => {
      assert.equal(foreign.subscriptionCount, 1);
      assert.deepEqual(
        await monitor.pubsub("NUMSUB", projectJobChannel(foreignProject)),
        [projectJobChannel(foreignProject), 1],
        "another suite's real subscription must remain untouched",
      );
    };
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
      // Deterministically reproduce concurrent SDK progress traffic. This must
      // stay live through normal disconnect AND SIGTERM, not be reset/ignored.
      foreignSubscription = await foreign.subscribe(foreignProject, () => {});
      await assertForeignActive();
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
            streams.push(normal);
            await until(
              control,
              (state) => state.subscriptions === 1 && state.redisChannels === 1,
              10000,
              `${mode}: normal subscription acknowledged`,
            );
            const normalAt = performance.now();
            normal.close();
            const normalReleased = await until(
              control,
              (state) => state.subscriptions === 0 && state.redisChannels === 0,
              10000,
              `${mode}: normal disconnect cleanup`,
            );
            const normalReleaseMs = performance.now() - normalAt;
            streams.pop();
            assert.equal(normalReleased.redisChannelScope, "fixture-projects");
            assert.ok(normalReleased.sharedRedisChannels >= 1);
            await assertForeignActive();
            for (const project of [projects[0], projects[0], projects[1]].slice(0, streamCount))
              streams.push(await connect(project, cookie));
            await until(
              control,
              (state) =>
                state.subscriptions === streamCount &&
                state.redisChannels === (streamCount === 1 ? 1 : 2),
              10000,
              `${mode}: pre-SIGTERM subscriptions acknowledged`,
            );
            const signalAt = performance.now();
            server.process.kill("SIGTERM");
            const released = until(
              control,
              (state) => state.subscriptions === 0 && state.redisChannels === 0,
              10000,
              `${mode}: SIGTERM cleanup`,
            ).then(() => performance.now() - signalAt);
            const [code] = await Promise.race([
              server.exited,
              delay(5000).then(() => {
                throw new Error(`${mode} did not exit within 5 seconds: ${server.output()}`);
              }),
            ]);
            const exitMs = performance.now() - signalAt;
            const upstreamReleaseMs = await released;
            await assertForeignActive();
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
            assert.doesNotMatch(server.output(), /MaxListenersExceededWarning/);
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
              foreignSubscriberPreserved: true,
              connectedFrameAcknowledged: true,
              fixtureRedisChannelsAfter: 0,
              sharedRedisChannelsAfterNormalClose: normalReleased.sharedRedisChannels,
            });
          } catch (error) {
            console.error(
              "US131_WEB_FAILURE",
              JSON.stringify({
                mode,
                streamCount,
                process: server.diagnostic(),
                transport: await control().catch(() => ({ unavailable: true })),
              }),
            );
            throw error;
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
    } catch (error) {
      console.error("US131_API_FAILURE", JSON.stringify(api.diagnostic()));
      throw error;
    } finally {
      try {
        await fetch("http://127.0.0.1:3032/reset", { method: "POST" }).catch(() => {});
        api.process.kill("SIGTERM");
        await api.exited;
      } finally {
        try {
          await foreignSubscription?.close();
        } finally {
          await foreign.close();
          monitor.disconnect();
        }
      }
    }
  },
);

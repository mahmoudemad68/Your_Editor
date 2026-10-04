/**
 * A real browser on another origin submits the sign-in form through a proxy
 * that adds client-supplied forwarded headers. The API must refuse the session.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { instant, type Instant } from "@editagent/domain";
import {
  LoginUser,
  LogoutUser,
  RefreshAccess,
  RegisterUser,
} from "./application/authentication.js";
import { type Clock } from "./application/clock.js";
import {
  InMemoryRefreshSessionRepository,
  InMemoryUserRepository,
} from "./application/in-memory-identity.js";
import { InMemoryMediaAssetRepository } from "./application/in-memory-media-repository.js";
import { InMemoryProjectRepository } from "./application/in-memory-project-repository.js";
import { LoginRateLimit } from "./application/login-rate-limit.js";
import { MemoryObjectStorage } from "./application/memory-object-storage.js";
import { createApiApplication } from "./create-api-application.js";
import { Argon2idHasher } from "./infrastructure/argon2id-hasher.js";
import { JwtSessionTokens } from "./infrastructure/jwt-session-tokens.js";
import { NodeMediaAssetIdGenerator } from "./infrastructure/node-media-asset-id-generator.js";
import { NodeProjectIdGenerator } from "./infrastructure/node-project-id-generator.js";

const SECRET = "local-development-jwt-secret-32chars";
const PASSWORD = "correct-horse-battery";

class MutableClock implements Clock {
  now(): Instant {
    return instant(1_700_000_000_000n);
  }
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a port");
      }
      resolve(address.port);
    });
  });
}

function chromePath(): string {
  const configured = process.env["CHROME_PATH"];
  const candidates = [
    configured,
    "/usr/local/bin/google-chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);
  const installed = candidates.find((candidate) => existsSync(candidate));
  if (installed !== undefined) {
    return installed;
  }
  const lookup = spawnSync("sh", ["-c", "command -v google-chrome"], { encoding: "utf8" });
  const resolved = lookup.stdout.trim();
  if (lookup.status === 0 && resolved.length > 0) {
    return resolved;
  }
  throw new Error(
    `google-chrome was not found. Set CHROME_PATH. Looked in ${candidates.join(", ")}.`,
  );
}

test("a cross-site browser form cannot inject a sign-in session", async () => {
  const clock = new MutableClock();
  const users = new InMemoryUserRepository();
  const sessions = new InMemoryRefreshSessionRepository();
  const passwords = new Argon2idHasher();
  const tokens = new JwtSessionTokens(SECRET);
  const rateLimit = new LoginRateLimit(20, 60_000);
  const app = await createApiApplication({
    projects: new InMemoryProjectRepository(),
    clock,
    ids: new NodeProjectIdGenerator(),
    media: new InMemoryMediaAssetRepository(),
    objects: new MemoryObjectStorage(),
    mediaIds: new NodeMediaAssetIdGenerator(),
    presignTtlSeconds: 900,
    auth: {
      register: new RegisterUser(users, sessions, passwords, tokens, clock, rateLimit),
      login: new LoginUser(users, sessions, passwords, tokens, clock, rateLimit),
      refresh: new RefreshAccess(users, sessions, tokens, clock),
      logout: new LogoutUser(sessions, clock),
      tokens,
      now: () => clock.now(),
      cookieSecure: false,
      trustedOrigins: ["http://app.example"],
      trustedProxies: [],
    },
  });
  await app.listen(0, "127.0.0.1");
  const apiAddress = app.getHttpServer().address();
  if (apiAddress === null || typeof apiAddress === "string") {
    throw new Error("expected a port");
  }
  const proxy = http.createServer((request, response) => {
    const headers = { ...request.headers };
    headers["x-forwarded-for"] = "203.0.113.8";
    headers["x-forwarded-proto"] = "https";
    headers["x-forwarded-host"] = "app.example";
    const forwarded = http.request(
      {
        hostname: "127.0.0.1",
        port: apiAddress.port,
        path: request.url,
        method: request.method,
        headers,
      },
      (upstream) => {
        response.writeHead(upstream.statusCode ?? 500, upstream.headers);
        upstream.pipe(response);
      },
    );
    forwarded.on("error", () => {
      response.writeHead(502);
      response.end();
    });
    request.pipe(forwarded);
  });
  const proxyPort = await listen(proxy);
  const attacker = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><form id="login" method="POST" action="http://127.0.0.1:${proxyPort}/auth/login">
      <input name="email" value="attacker@example.test">
      <input name="password" value="${PASSWORD}">
    </form><script>document.getElementById("login").submit()</script>`);
  });
  const attackerPort = await listen(attacker);
  const profile = mkdtempSync(path.join(tmpdir(), "editagent-chrome-"));
  const chrome = spawn(
    chromePath(),
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let chromeLog = "";
  chrome.stderr?.on("data", (chunk: Buffer) => {
    chromeLog += chunk.toString();
  });
  try {
    const version = await fetch(`http://127.0.0.1:${apiAddress.port}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://app.example" },
      body: JSON.stringify({ email: "attacker@example.test", password: PASSWORD }),
    });
    assert.equal(version.status, 201, await version.clone().text());
    const endpoint = await waitForDebugger(chrome, () => chromeLog);
    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(undefined));
      socket.addEventListener("error", () => reject(new Error("chrome socket failed")));
    });
    let next = 0;
    const pending = new Map<number, (value: CdpMessage) => void>();
    const events: CdpMessage[] = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
        return;
      }
      if (message.method !== undefined) {
        events.push(message);
      }
    });
    const call = (method: string, params: unknown = {}, sessionId?: string) => {
      const id = ++next;
      const payload: { id: number; method: string; params: unknown; sessionId?: string } = {
        id,
        method,
        params,
      };
      if (sessionId !== undefined) {
        payload.sessionId = sessionId;
      }
      socket.send(JSON.stringify(payload));
      return new Promise<CdpMessage>((resolve) => pending.set(id, resolve));
    };
    const created = await call("Target.createTarget", { url: "about:blank" });
    const targetId = created.result?.targetId;
    if (targetId === undefined) {
      throw new Error("chrome did not create a target");
    }
    const attached = await call("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = attached.result?.sessionId;
    if (sessionId === undefined) {
      throw new Error("chrome did not attach to the target");
    }
    await call("Network.enable", {}, sessionId);
    await call("Page.enable", {}, sessionId);
    await call("Page.navigate", { url: `http://127.0.0.1:${attackerPort}/` }, sessionId);
    const posted = await waitForLoginStatus(events, proxyPort);
    assert.equal(posted, 403);
    const cookies = await call("Network.getCookies", {}, sessionId);
    assert.equal(
      (cookies.result?.cookies ?? []).some((cookie) => cookie.name === "editagent_access"),
      false,
    );
    socket.close();
  } finally {
    chrome.kill("SIGTERM");
    attacker.close();
    proxy.close();
    await app.close();
  }
});

interface CdpMessage {
  id?: number;
  method?: string;
  result?: {
    targetId?: string;
    sessionId?: string;
    cookies?: Array<{ name: string }>;
  };
  params?: { response?: { status?: number; url?: string } };
}

async function waitForDebugger(
  chrome: ReturnType<typeof spawn>,
  log: () => string,
): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    const match = log().match(/ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-z0-9-]+/);
    if (match?.[0] !== undefined) {
      return match[0];
    }
    if (chrome.exitCode !== null) {
      throw new Error(`chrome exited\n${log()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`chrome debugger did not start\n${log()}`);
}

async function waitForLoginStatus(events: CdpMessage[], proxyPort: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    const found = events.find(
      (event) =>
        event.method === "Network.responseReceived" &&
        event.params?.response?.url?.includes(`127.0.0.1:${proxyPort}/auth/login`),
    );
    const status = found?.params?.response?.status;
    if (status !== undefined) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the browser did not submit the sign-in form");
}

import "reflect-metadata";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { type INestApplication } from "@nestjs/common";
import {
  createUuidV7,
  instant,
  MediaAsset,
  mediaAssetId,
  projectId,
  User,
  userId,
  type Instant,
} from "@editagent/domain";
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
import { CSRF_HEADER } from "./presentation/auth-cookies.js";

const SECRET = "local-development-jwt-secret-32chars";
const PASSWORD = "correct-horse-battery";
const MEDIA_ID = "018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4f";
const MEDIA_HASH = "ab".repeat(32);
const MEDIA_NAME = "private-reel-secret.mp4";

class MutableClock implements Clock {
  constructor(private current: Instant) {}

  now(): Instant {
    return this.current;
  }

  advance(by: bigint): void {
    this.current += by;
  }
}

interface RunningApi {
  readonly app: INestApplication;
  readonly base: string;
  readonly users: InMemoryUserRepository;
  readonly projects: InMemoryProjectRepository;
  readonly media: InMemoryMediaAssetRepository;
  readonly clock: MutableClock;
  readonly passwords: Argon2idHasher;
}

async function startApi(limit: number): Promise<RunningApi> {
  const users = new InMemoryUserRepository();
  const sessions = new InMemoryRefreshSessionRepository();
  const projects = new InMemoryProjectRepository();
  const media = new InMemoryMediaAssetRepository();
  const clock = new MutableClock(instant(1_700_000_000_000n));
  const passwords = new Argon2idHasher();
  const tokens = new JwtSessionTokens(SECRET);
  const rateLimit = new LoginRateLimit(limit, 60_000);
  const app = await createApiApplication({
    projects,
    clock,
    ids: new NodeProjectIdGenerator(),
    media,
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
      trustedOrigins: [],
      trustedProxies: [],
    },
  });
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a port");
  }
  return {
    app,
    base: `http://127.0.0.1:${address.port}`,
    users,
    projects,
    media,
    clock,
    passwords,
  };
}

function cookieJar(response: Response): Map<string, string> {
  const jar = new Map<string, string>();
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const pair = line.split(";")[0] ?? "";
    const split = pair.indexOf("=");
    if (split > 0) {
      jar.set(pair.slice(0, split), decodeURIComponent(pair.slice(split + 1)));
    }
  }
  return jar;
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()]
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");
}

interface ErrorBody {
  message: string;
}

async function errorBody(response: Response): Promise<ErrorBody> {
  return (await response.json()) as ErrorBody;
}

function jsonHeaders(jar?: Map<string, string>, csrf = true): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (jar !== undefined) {
    headers.cookie = cookieHeader(jar);
    if (csrf) {
      headers[CSRF_HEADER] = jar.get("editagent_csrf") ?? "";
    }
  }
  return headers;
}

async function register(api: RunningApi, email: string): Promise<Map<string, string>> {
  const response = await fetch(`${api.base}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return cookieJar(response);
}

test("a signed-in user creates a private project and a stranger receives 404", async () => {
  const api = await startApi(40);
  try {
    const registered = await fetch(`${api.base}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "Owner@Example.test", password: PASSWORD }),
    });
    assert.equal(registered.status, 201, await registered.clone().text());
    const setCookie = registered.headers.getSetCookie?.().join("\n") ?? "";
    assert.match(setCookie, /editagent_access=[^\n]*HttpOnly/);
    assert.match(setCookie, /editagent_refresh=[^\n]*Path=\/auth[^\n]*HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.doesNotMatch(setCookie, /editagent_csrf=[^\n]*HttpOnly/);
    assert.equal(registered.headers.get("x-content-type-options"), "nosniff");
    assert.equal(registered.headers.get("x-frame-options"), "DENY");
    const owner = cookieJar(registered);
    const stored = await api.users.findByEmail("owner@example.test");
    assert.ok(stored);
    assert.equal(stored.passwordHash.startsWith("$argon2id$"), true);
    assert.equal(stored.passwordHash.includes(PASSWORD), false);
    assert.equal(await api.passwords.verify(stored.passwordHash, PASSWORD), true);

    const duplicate = await fetch(`${api.base}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.test", password: PASSWORD }),
    });
    assert.equal(duplicate.status, 409);
    const shortPassword = await fetch(`${api.base}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "short@example.test", password: "too-short" }),
    });
    assert.equal(shortPassword.status, 400);

    const anonymous = await fetch(`${api.base}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nope" }),
    });
    assert.equal(anonymous.status, 401);

    const created = await fetch(`${api.base}/projects`, {
      method: "POST",
      headers: jsonHeaders(owner),
      body: JSON.stringify({ name: "Private footage" }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const project = (await created.json()) as { id: string; name: string };
    assert.equal(project.name, "Private footage");

    const missingCsrf = await fetch(`${api.base}/projects`, {
      method: "POST",
      headers: jsonHeaders(owner, false),
      body: JSON.stringify({ name: "Blocked" }),
    });
    assert.equal(missingCsrf.status, 403);
    const bearer = await fetch(`${api.base}/projects`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${owner.get("editagent_access") ?? ""}`,
      },
      body: JSON.stringify({ name: "Bearer project" }),
    });
    assert.equal(bearer.status, 201, await bearer.clone().text());

    await api.media.save(
      MediaAsset.createUploaded({
        id: mediaAssetId(MEDIA_ID),
        projectId: projectId(project.id),
        createdAt: api.clock.now(),
        displayFilename: MEDIA_NAME,
        mimeType: "video/mp4",
        byteSize: 4,
        contentSha256: MEDIA_HASH,
      }),
    );

    const stranger = await register(api, "other@example.test");
    const hiddenList = await fetch(`${api.base}/projects`, {
      headers: { cookie: cookieHeader(stranger) },
    });
    const hiddenListBody = await hiddenList.text();
    assert.equal(hiddenList.status, 200);
    assert.equal(hiddenListBody.includes("Private footage"), false);
    const hidden = await fetch(`${api.base}/projects/${project.id}`, {
      method: "PATCH",
      headers: jsonHeaders(stranger),
      body: JSON.stringify({ name: "Stolen" }),
    });
    const hiddenBody = await hidden.text();
    assert.equal(hidden.status, 404);
    assert.equal(hiddenBody.includes("Private footage"), false);
    assert.equal(hiddenBody.includes(MEDIA_NAME), false);
    assert.equal(hiddenBody.includes("403"), false);
    const missingMedia = await fetch(`${api.base}/projects/${project.id}/media/${MEDIA_ID}`, {
      headers: { cookie: cookieHeader(stranger) },
    });
    const mediaBody = await missingMedia.text();
    assert.equal(missingMedia.status, 404);
    assert.equal(mediaBody.includes("Private footage"), false);
    assert.equal(mediaBody.includes(MEDIA_NAME), false);
    assert.equal(mediaBody.includes(MEDIA_HASH), false);

    const viewerJar = await register(api, "viewer@example.test");
    const viewer = await api.users.findByEmail("viewer@example.test");
    const loaded = await api.projects.findById(projectId(project.id));
    assert.ok(viewer);
    assert.ok(loaded);
    await api.projects.save(
      loaded.project.grantMembership(stored.id, viewer.id, "viewer", api.clock.now()),
      loaded.revision,
    );
    const viewerRename = await fetch(`${api.base}/projects/${project.id}`, {
      method: "PATCH",
      headers: jsonHeaders(viewerJar),
      body: JSON.stringify({ name: "Viewer edit" }),
    });
    assert.equal(viewerRename.status, 403);

    const admin = User.create(
      userId(createUuidV7(Number(api.clock.now()), randomBytes(10))),
      "admin@example.test",
      await api.passwords.hash(PASSWORD),
      api.clock.now(),
      "admin",
    );
    await api.users.save(admin);
    const adminLogin = await fetch(`${api.base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@example.test", password: PASSWORD }),
    });
    assert.equal(adminLogin.status, 200, await adminLogin.clone().text());
    const adminJar = cookieJar(adminLogin);
    const adminRead = await fetch(`${api.base}/projects/${project.id}`, {
      method: "PATCH",
      headers: jsonHeaders(adminJar),
      body: JSON.stringify({ name: "Operator" }),
    });
    const adminBody = await adminRead.text();
    assert.equal(adminRead.status, 404);
    assert.equal(adminBody.includes("Private footage"), false);

    const refreshed = await fetch(`${api.base}/auth/refresh`, {
      method: "POST",
      headers: {
        cookie: cookieHeader(owner),
        [CSRF_HEADER]: owner.get("editagent_csrf") ?? "",
      },
    });
    assert.equal(refreshed.status, 200, await refreshed.clone().text());
    const rotated = cookieJar(refreshed);
    const reused = await fetch(`${api.base}/auth/refresh`, {
      method: "POST",
      headers: {
        cookie: cookieHeader(owner),
        [CSRF_HEADER]: owner.get("editagent_csrf") ?? "",
      },
    });
    assert.equal(reused.status, 401);
    const rotatedAgain = await fetch(`${api.base}/auth/refresh`, {
      method: "POST",
      headers: {
        cookie: cookieHeader(rotated),
        [CSRF_HEADER]: rotated.get("editagent_csrf") ?? "",
      },
    });
    assert.equal(rotatedAgain.status, 401);

    api.clock.advance(16n * 60n * 1000n);
    const expired = await fetch(`${api.base}/projects`, {
      headers: { cookie: `editagent_access=${rotated.get("editagent_access") ?? ""}` },
    });
    assert.equal(expired.status, 401);

    const loggedOut = await fetch(`${api.base}/auth/logout`, {
      method: "POST",
      headers: {
        cookie: cookieHeader(rotated),
        [CSRF_HEADER]: rotated.get("editagent_csrf") ?? "",
      },
    });
    assert.equal(loggedOut.status, 204);

    const wrong = await fetch(`${api.base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.test", password: "not-the-password" }),
    });
    const unknown = await fetch(`${api.base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "missing@example.test", password: PASSWORD }),
    });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    const wrongBody = await errorBody(wrong);
    const unknownBody = await errorBody(unknown);
    assert.equal(wrongBody.message, "Email or password is incorrect.");
    assert.deepEqual(wrongBody, unknownBody);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const again = await fetch(`${api.base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@example.test", password: "not-the-password" }),
      });
      assert.equal(again.status, 401);
      assert.deepEqual(await errorBody(again), wrongBody);
    }
    const locked = await api.users.findByEmail("owner@example.test");
    assert.equal(locked?.failedLoginCount, 5);
    assert.equal(locked?.isLocked(api.clock.now()), true);
    const duringLock = await fetch(`${api.base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.test", password: PASSWORD }),
    });
    assert.equal(duringLock.status, 401);
    const duringLockBody = await errorBody(duringLock);
    assert.deepEqual(duringLockBody, wrongBody);
    assert.equal(JSON.stringify(duringLockBody).toLowerCase().includes("lock"), false);
    assert.equal((await api.users.findByEmail("owner@example.test"))?.failedLoginCount, 5);
  } finally {
    await api.app.close();
  }
});

test("production authentication does not accept x-test-actor", async () => {
  const api = await startApi(5);
  try {
    const response = await fetch(`${api.base}/projects`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-actor": "018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f",
      },
      body: JSON.stringify({ name: "Launch" }),
    });
    assert.equal(response.status, 401);
  } finally {
    await api.app.close();
  }
});

test("credential attempts from one client are rate limited", async () => {
  const api = await startApi(2);
  try {
    assert.equal((await register(api, "one@example.test")).has("editagent_access"), true);
    assert.equal((await register(api, "two@example.test")).has("editagent_access"), true);
    const limited = await fetch(`${api.base}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "three@example.test", password: PASSWORD }),
    });
    assert.equal(limited.status, 429);
    assert.equal(await api.users.findByEmail("three@example.test"), null);
  } finally {
    await api.app.close();
  }
});

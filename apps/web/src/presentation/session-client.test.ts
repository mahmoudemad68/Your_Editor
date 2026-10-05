import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionClient } from "./session-client";

const user = { id: "verified", email: "owner@example.test" };
const json = (body: unknown, status = 200) => Response.json(body, { status });
const noLock = async <T>(work: () => Promise<T>): Promise<T> => work();

test("concurrent and late 401 envelopes share one refresh and retry with rotated CSRF", async () => {
  let refreshed = false;
  let rotations = 0;
  const headers: string[] = [];
  const client = new SessionClient(
    async (input, init) => {
      const url = String(input);
      if (url === "/auth/me") return refreshed ? json(user) : json({}, 401);
      if (url === "/auth/refresh") {
        rotations++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        refreshed = true;
        return json(user);
      }
      headers.push(new Headers(init?.headers).get("x-editagent-csrf") ?? "");
      const allowed = refreshed;
      if (url === "/api/late" && !allowed) await new Promise((resolve) => setTimeout(resolve, 60));
      return json(allowed ? { ok: true, data: [] } : { ok: false, status: 401 });
    },
    () => (refreshed ? "rotated" : "original"),
    noLock,
  );
  const results = await Promise.all(
    ["/api/a", "/api/b", "/api/late"].map((url) =>
      client.authenticatedFetch(url, { method: "POST" }),
    ),
  );
  for (const response of results) assert.equal((await response.json()).ok, true);
  assert.equal(rotations, 1);
  assert.deepEqual(headers, ["original", "original", "original", "rotated", "rotated", "rotated"]);
  assert.deepEqual(client.getSnapshot(), { status: "authenticated", user });
});

test("unrecoverable refresh redirects state to unauthenticated without retry loops", async () => {
  const calls: string[] = [];
  const client = new SessionClient(
    async (input) => {
      calls.push(String(input));
      return json({}, 401);
    },
    () => "csrf",
    noLock,
  );
  await client.bootstrap();
  assert.equal(client.getSnapshot().status, "unauthenticated");
  assert.deepEqual(calls, ["/auth/me", "/auth/me", "/auth/refresh"]);
  await client.authenticatedFetch("/api/a");
  assert.equal(calls.filter((url) => url === "/auth/refresh").length, 1);
});

test("a second 401 after successful refresh ends the session after exactly one retry", async () => {
  let calls = 0;
  const client = new SessionClient(
    async (url) => {
      if (String(url) === "/auth/refresh") return json(user);
      if (String(url) === "/api/a") calls++;
      return json({}, 401);
    },
    () => "csrf",
    noLock,
  );
  await client.authenticatedFetch("/api/a");
  assert.equal(calls, 2);
  assert.equal(client.getSnapshot().status, "unauthenticated");
});

test("read-only requests omit CSRF; explicit browser CSRF is sent on logout", async () => {
  const calls: { url: string; csrf: string | null }[] = [];
  const client = new SessionClient(
    async (input, init) => {
      calls.push({ url: String(input), csrf: new Headers(init?.headers).get("x-editagent-csrf") });
      return String(input) === "/auth/logout" ? new Response(null, { status: 204 }) : json(user);
    },
    () => "readable-csrf",
    noLock,
  );
  await client.bootstrap();
  assert.deepEqual(client.getSnapshot(), { status: "authenticated", user });
  assert.equal(await client.logout(), null);
  assert.equal(client.getSnapshot().status, "unauthenticated");
  assert.deepEqual(calls, [
    { url: "/auth/me", csrf: null },
    { url: "/auth/logout", csrf: "readable-csrf" },
  ]);
});

test("authentication errors are usable and never expose server details", async () => {
  for (const [status, expected] of [
    [401, "Email or password is incorrect."],
    [409, "An account with that email already exists. Sign in instead."],
    [429, "Too many attempts. Please wait a minute before trying again."],
  ] as const) {
    const client = new SessionClient(
      async () => json({ message: "private server details" }, status),
      () => null,
      noLock,
    );
    assert.equal(
      await client.authenticate(
        status === 409 ? "register" : "login",
        "owner@example.test",
        "password",
      ),
      expected,
    );
  }
});

test("network failure is retryable and cannot manufacture an identity", async () => {
  const client = new SessionClient(
    async () => {
      throw new Error("offline");
    },
    () => null,
    noLock,
  );
  await client.bootstrap();
  assert.equal(client.getSnapshot().status, "error");
  await assert.rejects(client.authenticatedFetch("https://evil.example"));
});

test("an in-flight bootstrap cannot restore stale identity after logout", async () => {
  let finish!: (response: Response) => void;
  const client = new SessionClient(
    async (url) => {
      if (String(url) === "/auth/logout") return new Response(null, { status: 204 });
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    },
    () => "csrf",
    noLock,
  );
  const checking = client.bootstrap();
  assert.equal(await client.logout(), null);
  finish(json(user));
  await checking;
  assert.equal(client.getSnapshot().status, "unauthenticated");
});

test("late 401 waits for the shared refresh body before retrying", async () => {
  let refreshStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  let rotated = false;
  let rotations = 0;
  const client = new SessionClient(
    async (url) => {
      if (String(url) === "/auth/me") return json({}, 401);
      if (String(url) === "/auth/refresh") {
        rotations++;
        refreshStarted();
        return new Response(
          new ReadableStream({
            start(controller) {
              setTimeout(() => {
                rotated = true;
                controller.enqueue(new TextEncoder().encode(JSON.stringify(user)));
                controller.close();
              }, 30);
            },
          }),
        );
      }
      return rotated ? json({ ok: true }) : json({}, 401);
    },
    () => "csrf",
    noLock,
  );
  const early = client.authenticatedFetch("/api/early");
  await started;
  const late = client.authenticatedFetch("/api/late");
  for (const response of await Promise.all([early, late]))
    assert.equal((await response.json()).ok, true);
  assert.equal(rotations, 1);
});

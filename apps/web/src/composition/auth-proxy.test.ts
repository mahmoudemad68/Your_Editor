import assert from "node:assert/strict";
import { test } from "node:test";
import { proxyAuth } from "./auth-proxy";

test("cross-site and untrusted login/register requests are refused before upstream", async () => {
  for (const action of ["login", "register"] as const) {
    for (const headers of [
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
      { origin: "null", "x-forwarded-host": "app.example", "x-forwarded-proto": "https" },
    ] as Record<string, string>[]) {
      const response = await proxyAuth(
        new Request(`https://app.example/auth/${action}`, { method: "POST", headers }),
        action,
        "http://api",
        async () => {
          throw new Error("must not forward");
        },
      );
      assert.equal(response.status, 403);
      assert.deepEqual(response.headers.getSetCookie(), []);
    }
  }
});

test("auth proxy preserves cookie lines/attributes and incoming security headers", async () => {
  const cookies = [
    "editagent_access=opaque; Path=/; HttpOnly; Secure; SameSite=Lax",
    "editagent_refresh=opaque; Path=/auth; HttpOnly; Secure; SameSite=Lax",
    "editagent_csrf=readable; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Secure; SameSite=Lax",
  ];
  const response = await proxyAuth(
    new Request("https://app.example/auth/refresh", {
      method: "POST",
      headers: {
        cookie: "editagent_refresh=opaque; editagent_csrf=readable",
        "x-editagent-csrf": "explicit",
        "x-request-id": "web-auth-request",
        origin: "https://app.example",
      },
    }),
    "refresh",
    "http://api",
    async (url, init) => {
      assert.equal(url, "http://api/auth/refresh");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("cookie"), "editagent_refresh=opaque; editagent_csrf=readable");
      assert.equal(headers.get("x-editagent-csrf"), "explicit");
      assert.equal(headers.get("origin"), "https://app.example");
      if (url === "http://api/auth/refresh")
        assert.equal(headers.get("x-request-id"), "web-auth-request");
      const reply = Response.json({ id: "user", email: "owner@example.test" });
      for (const cookie of cookies) reply.headers.append("set-cookie", cookie);
      return reply;
    },
  );
  assert.deepEqual(response.headers.getSetCookie(), cookies);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});

test("ambient CSRF cookie never becomes a server-generated CSRF header", async () => {
  const response = await proxyAuth(
    new Request("https://app.example/auth/logout", {
      method: "POST",
      headers: { cookie: "editagent_csrf=ambient" },
    }),
    "logout",
    "http://api",
    async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("x-editagent-csrf"), null);
      return new Response(null, {
        status: 204,
        headers: { "set-cookie": "editagent_refresh=; Path=/auth; Max-Age=0; HttpOnly" },
      });
    },
  );
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
});

test("internal Next listener hostname does not replace the original browser Origin", async () => {
  await proxyAuth(
    new Request("http://localhost:3000/auth/login", {
      method: "POST",
      headers: {
        host: "app.example",
        origin: "https://app.example",
        "x-forwarded-host": "evil.example",
      },
    }),
    "login",
    "http://api",
    async (_url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("origin"), "https://app.example");
      assert.equal(headers.get("x-forwarded-host"), null);
      return Response.json({ id: "verified", email: "owner@example.test" });
    },
  );
});

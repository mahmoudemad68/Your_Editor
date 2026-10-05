import assert from "node:assert/strict";
import { test } from "node:test";
import { csrfMatches, readCookie, sessionCookies } from "./auth-cookies.js";

const session = {
  accessToken: "access.token",
  accessExpiresAt: 2_000n,
  refreshToken: "session.secret",
  refreshExpiresAt: 90_000n,
  csrfToken: "csrf-token",
};

test("session cookies are httpOnly and SameSite except the CSRF cookie", () => {
  const cookies = sessionCookies(session, 1_000n, false);
  const access = cookies.find((cookie) => cookie.startsWith("editagent_access="));
  const refresh = cookies.find((cookie) => cookie.startsWith("editagent_refresh="));
  const csrf = cookies.find((cookie) => cookie.startsWith("editagent_csrf="));
  assert.ok(access);
  assert.match(access, /HttpOnly/);
  assert.match(access, /SameSite=Lax/);
  assert.match(access, /Path=\//);
  assert.doesNotMatch(access, /Secure/);
  assert.ok(refresh);
  assert.match(refresh, /HttpOnly/);
  assert.match(refresh, /Path=\/auth/);
  assert.match(refresh, /SameSite=Lax/);
  assert.ok(csrf);
  assert.doesNotMatch(csrf, /HttpOnly/);
  assert.match(csrf, /SameSite=Lax/);
  const secure = sessionCookies(session, 1_000n, true).join("\n");
  assert.match(secure, /Secure/);
});

test("cookie and CSRF comparison reject a missing or different token", () => {
  const header = "editagent_access=a%2Bb; editagent_csrf=csrf-token";
  assert.equal(readCookie(header, "editagent_access"), "a+b");
  assert.equal(csrfMatches("csrf-token", "csrf-token"), true);
  assert.equal(csrfMatches("other", "csrf-token"), false);
  assert.equal(csrfMatches(undefined, "csrf-token"), false);
});

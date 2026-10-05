import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

const PASSWORD = "correct-horse-battery";
const EMAIL = "creator@example.test";
const control = async (request: APIRequestContext, path: string, data: object = {}) => {
  const response = await request.post(`http://127.0.0.1:3032/${path}`, { data });
  expect(response.ok()).toBe(true);
};
async function credentials(
  page: Page,
  mode: "Sign in" | "Sign up",
  email = EMAIL,
  password = PASSWORD,
) {
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: mode, exact: true }).click();
}
async function signup(page: Page) {
  await page.goto("/sign-up");
  await credentials(page, "Sign up");
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(page.getByText(EMAIL, { exact: true })).toBeVisible();
}
async function project(page: Page) {
  await page.getByRole("button", { name: "Create project", exact: true }).first().click();
  await page.getByLabel("Project name", { exact: true }).fill("My private edit");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const link = page.getByRole("link", { name: "Open project" });
  await expect(link).toBeVisible();
  return (await link.getAttribute("href"))!;
}

test.beforeEach(async ({ request }) => {
  await control(request, "reset");
});

test("AC1: registration reaches the dashboard and creates a project in under one minute; logout/sign-in/reload", async ({
  page,
  context,
}) => {
  const start = Date.now();
  await signup(page);
  await project(page);
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(60_000);
  console.info(`US-119 AC1 registration + project creation: ${elapsed}ms (under 60 seconds)`);
  const cookies = await context.cookies();
  expect(cookies.find((c) => c.name === "editagent_access")?.httpOnly).toBe(true);
  expect(cookies.find((c) => c.name === "editagent_refresh")?.httpOnly).toBe(true);
  expect(cookies.find((c) => c.name === "editagent_refresh")?.path).toBe("/auth");
  expect(cookies.find((c) => c.name === "editagent_csrf")?.httpOnly).toBe(false);
  expect(
    await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
  ).toEqual({ local: {}, session: {} });
  expect(await page.evaluate(() => document.cookie)).not.toMatch(/editagent_(access|refresh)=/);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in(?:\?|$)/);
  expect((await context.cookies()).filter((c) => c.name.startsWith("editagent_")).length).toBe(0);
  await credentials(page, "Sign in");
  await expect(page.getByText(EMAIL, { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText(EMAIL, { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
  ).toEqual({ local: {}, session: {} });
});

test("protected route hides application content and redirects anonymous users", async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: "editagent_access", value: "forged", domain: "127.0.0.1", path: "/", httpOnly: true },
  ]);
  const target = "/projects/018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4f";
  await page.goto(target);
  await expect(page).toHaveURL(`/sign-in?returnTo=${encodeURIComponent(target)}`);
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
});

test("AC2: expired refresh session requires login and returns to the original internal page", async ({
  page,
  request,
}) => {
  await signup(page);
  const target = await project(page);
  await control(request, "advance", { ms: 15 * 24 * 60 * 60 * 1000 });
  const destination = `${target}?tab=media&label=My%20edit`;
  await page.goto(destination);
  await expect(page).toHaveURL(`/sign-in?returnTo=${encodeURIComponent(destination)}`);
  await credentials(page, "Sign in");
  await expect(page).toHaveURL(destination);
  await expect(page.getByRole("heading", { name: "My private edit", exact: true })).toBeVisible();
});

test("expired access silently refreshes once across simultaneous tabs, then mutations use rotated CSRF", async ({
  page,
  context,
  request,
}) => {
  await signup(page);
  const target = await project(page);
  await control(request, "advance", { ms: 901_000 });
  const pages = [page, await context.newPage(), await context.newPage()];
  try {
    await Promise.all(pages.map((tab) => tab.goto("/")));
    for (const tab of pages) await expect(tab.getByText(EMAIL, { exact: true })).toBeVisible();
    const metrics = await request.get("http://127.0.0.1:3032/metrics");
    expect((await metrics.json()).rotations).toBe(1);
    const renamed = await page.evaluate(async (path) => {
      const csrf = decodeURIComponent(
        document.cookie
          .split(";")
          .find((part) => part.trim().startsWith("editagent_csrf="))!
          .trim()
          .split("=")[1]!,
      );
      const response = await fetch(`/api${path}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-editagent-csrf": csrf },
        body: JSON.stringify({ name: "Recovered edit" }),
      });
      return response.json();
    }, target);
    expect(renamed.ok).toBe(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Recovered edit" })).toBeVisible();
  } finally {
    await Promise.all(pages.slice(1).map((tab) => tab.close()));
  }
});

test("revoked session redirects to sign-in", async ({ page, request, context }) => {
  await signup(page);
  await control(request, "revoke", { email: EMAIL });
  await context.clearCookies({ name: "editagent_access" });
  await page.reload();
  await expect(page).toHaveURL(/\/sign-in\?returnTo=/);
});

test("external or malformed return targets cannot redirect outside the dashboard", async ({
  page,
  request,
}) => {
  for (const target of [
    "https://evil.example",
    "//evil.example",
    "javascript:alert(1)",
    "/%5cevil.example",
    "/%zz",
  ]) {
    await control(request, "reset");
    await page.goto(`/sign-up?returnTo=${encodeURIComponent(target)}`);
    await credentials(page, "Sign up");
    await expect(page).toHaveURL("/");
    await expect(page.getByText(EMAIL, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/sign-in(?:\?|$)/);
  }
});

test("invalid credentials, malformed signup, conflict and rate limiting have usable errors", async ({
  page,
}) => {
  await page.goto("/sign-up");
  await credentials(page, "Sign up", "a@b..com", "short");
  await expect(
    page.getByText("Enter a valid email address (maximum 254 characters)."),
  ).toBeVisible();
  await expect(page.getByText("Use a password between 12 and 200 characters.")).toBeVisible();
  await credentials(page, "Sign up");
  await expect(page.getByText(EMAIL, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in(?:\?|$)/);
  await credentials(page, "Sign in", EMAIL, "incorrect-password");
  await expect(page.locator("form").getByRole("alert")).toHaveText(
    "Email or password is incorrect.",
  );
  await page.goto("/sign-up");
  await credentials(page, "Sign up");
  await expect(page.locator("form").getByRole("alert")).toContainText(
    "An account with that email already exists.",
  );
  // Exercise the real backend limiter; unknown-account attempts do not lock this user.
  await page.evaluate(async () => {
    for (let i = 0; i < 31; i++)
      await fetch("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "unknown@example.test", password: "incorrect-password" }),
      });
  });
  await page.goto("/sign-in");
  await credentials(page, "Sign in", "unknown@example.test");
  await expect(page.locator("form").getByRole("alert")).toHaveText(
    "Too many attempts. Please wait a minute before trying again.",
  );
});

test("F1: credential rate-limit isolation through the real BFF", async ({ page, browser }) => {
  await signup(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in(?:\?|$)/);
  const attempt = async (client: Page, email: string, action = "login", password = PASSWORD) =>
    client.evaluate(
      async ({ email, action, password }) => {
        const response = await fetch(`/auth/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        return { status: response.status, body: await response.json() };
      },
      { email, action, password },
    );
  let attackerStatus = 401;
  for (let i = 0; i < 31 && attackerStatus !== 429; i++) {
    attackerStatus = (await attempt(page, "attacker@example.test")).status;
    expect([401, 429]).toContain(attackerStatus);
  }
  expect(attackerStatus).toBe(429);
  const victim = await browser.newContext();
  try {
    const other = await victim.newPage();
    await other.goto("http://127.0.0.1:3030/sign-in");
    const login = await attempt(other, EMAIL);
    expect(login.status).toBe(200);
    expect(login.body.email).toBe(EMAIL);
    const registration = await attempt(other, "new-user@example.test", "register");
    expect(registration.status).toBe(201);
    expect(registration.body.email).toBe("new-user@example.test");
    expect((await attempt(page, " ATTACKER@Example.test ")).status).toBe(429);
    console.info(
      "F1: attacker 429; separate client login 200; unrelated registration 201; normalized attacker still 429",
    );
  } finally {
    await victim.close();
  }
});

test("ambient cookies cannot authorize project mutations, refresh or logout without explicit CSRF", async ({
  page,
}) => {
  await signup(page);
  const results = await page.evaluate(async () => {
    const project = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "blocked" }),
    });
    const refresh = await fetch("/auth/refresh", { method: "POST" });
    const logout = await fetch("/auth/logout", { method: "POST" });
    return { project: await project.json(), refresh: refresh.status, logout: logout.status };
  });
  expect(results.project).toMatchObject({ ok: false, status: 403 });
  expect(results.refresh).toBe(403);
  expect(results.logout).toBe(403);
  await page.reload();
  await expect(page.getByText(EMAIL, { exact: true })).toBeVisible();
});

for (const action of ["login", "register"]) {
  test(`actual web /auth/${action} blocks hostile cross-site form and fetch`, async ({
    page,
    context,
  }) => {
    await page.goto(`http://localhost:3032/hostile?target=${action}`);
    const hostileFetch = page.waitForResponse(`http://127.0.0.1:3030/auth/${action}`);
    const fetched = await page.evaluate(async (endpoint) => {
      const response = await fetch(`http://127.0.0.1:3030/auth/${endpoint}`, {
        method: "POST",
        mode: "no-cors",
        credentials: "include",
        headers: { "content-type": "text/plain" },
        body: "hostile",
      });
      return response.type;
    }, action);
    expect(fetched).toBe("opaque");
    expect((await hostileFetch).status()).toBe(403);
    const response = page.waitForResponse(`http://127.0.0.1:3030/auth/${action}`);
    await page.getByRole("button", { name: "Submit hostile form" }).click();
    expect((await response).status()).toBe(403);
    expect((await context.cookies()).filter((c) => c.name.startsWith("editagent_")).length).toBe(0);
    await page.goto("/sign-up");
    await credentials(page, "Sign up", "hostile@example.test");
    await expect(page.getByText("hostile@example.test", { exact: true })).toBeVisible();
  });
}

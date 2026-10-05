/** Test-only Nest composition. Controls are on a separate loopback listener,
 * never exposed through the Next BFF or shipped in either production image.
 * Uses US-118's real JWT, Argon2, rotation, origin guard and CSRF implementation.
 */
import { createServer } from "node:http";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const { instant } = require("@editagent/domain");
const { createApiApplication } = require("./dist/create-api-application.js");
const {
  RegisterUser,
  LoginUser,
  RefreshAccess,
  LogoutUser,
} = require("./dist/application/authentication.js");
const { GetCurrentUser } = require("./dist/application/current-user.js");
const {
  InMemoryUserRepository,
  InMemoryRefreshSessionRepository,
} = require("./dist/application/in-memory-identity.js");
const { InMemoryProjectRepository } = require("./dist/application/in-memory-project-repository.js");
const {
  InMemoryMediaAssetRepository,
} = require("./dist/application/in-memory-media-repository.js");
const { MemoryObjectStorage } = require("./dist/application/memory-object-storage.js");
const { LoginRateLimit } = require("./dist/application/login-rate-limit.js");
const { Argon2idHasher } = require("./dist/infrastructure/argon2id-hasher.js");
const { JwtSessionTokens } = require("./dist/infrastructure/jwt-session-tokens.js");
const { NodeProjectIdGenerator } = require("./dist/infrastructure/node-project-id-generator.js");
const {
  NodeMediaAssetIdGenerator,
} = require("./dist/infrastructure/node-media-asset-id-generator.js");
const { createServiceLogger } = require("@editagent/shared");

let app;
let offset = 0n;
let rotations = 0;
let users;
let sessions;
let now;
async function reset() {
  if (app) await app.close();
  offset = 0n;
  rotations = 0;
  now = () => instant(BigInt(Date.now()) + offset);
  const clock = { now };
  users = new InMemoryUserRepository();
  sessions = new InMemoryRefreshSessionRepository();
  const passwords = new Argon2idHasher();
  const tokens = new JwtSessionTokens("us119-browser-fixture-signing-key-at-least-32chars");
  const rateLimit = new LoginRateLimit(30, 60_000);
  const refresh = new RefreshAccess(users, sessions, tokens, clock);
  const execute = refresh.execute.bind(refresh);
  refresh.execute = async (token) => {
    rotations++;
    const result = await execute(token);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return result;
  };
  const logger = createServiceLogger("us119-e2e");
  logger.level = "silent";
  app = await createApiApplication(
    {
      projects: new InMemoryProjectRepository(),
      clock,
      ids: new NodeProjectIdGenerator(),
      media: new InMemoryMediaAssetRepository(),
      objects: new MemoryObjectStorage(),
      mediaIds: new NodeMediaAssetIdGenerator(),
      presignTtlSeconds: 900,
      auth: {
        currentUser: new GetCurrentUser(users),
        register: new RegisterUser(users, sessions, passwords, tokens, clock, rateLimit),
        login: new LoginUser(users, sessions, passwords, tokens, clock, rateLimit),
        refresh,
        logout: new LogoutUser(sessions, clock),
        tokens,
        now,
        cookieSecure: false,
        trustedOrigins: ["http://127.0.0.1:3030"],
        trustedProxies: [],
      },
    },
    undefined,
    logger,
  );
  await app.listen(3031, "127.0.0.1");
}
await reset();
const control = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url, "http://localhost:3032");
    if (url.pathname === "/hostile") {
      const target = url.searchParams.get("target") === "register" ? "register" : "login";
      response.setHeader("content-type", "text/html");
      response.end(
        `<form method="POST" action="http://127.0.0.1:3030/auth/${target}"><input name="email" value="hostile@example.test"><input name="password" value="correct-horse-battery"><button>Submit hostile form</button></form>`,
      );
      return;
    }
    if (request.method === "POST") {
      let text = "";
      for await (const chunk of request) text += chunk;
      const body = JSON.parse(text || "{}");
      if (url.pathname === "/reset") await reset();
      else if (url.pathname === "/advance") offset += BigInt(body.ms);
      else if (url.pathname === "/revoke") {
        const user = await users.findByEmail(body.email);
        if (user) await sessions.revokeAllForUser(user.id, now());
      }
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ rotations }));
  })().catch(() => {
    response.statusCode = 500;
    response.end("Fixture control failed");
  });
});
await new Promise((resolve) => control.listen(3032, "127.0.0.1", resolve));
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await new Promise((resolve) => control.close(resolve));
  await app.close();
}
process.on("SIGTERM", () => {
  void close();
});
process.on("SIGINT", () => {
  void close();
});

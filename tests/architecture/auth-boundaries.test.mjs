import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(fullPath));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

test("production authentication does not honor a development actor header", () => {
  const main = readFileSync(path.join(root, "apps/api/src/main.ts"), "utf8");
  const presentation = sourceFiles(path.join(root, "apps/api/src/presentation"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const application = sourceFiles(path.join(root, "apps/api/src/application"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const domain = sourceFiles(path.join(root, "packages/domain/src"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

  assert.match(main, /Argon2idHasher/);
  assert.match(main, /JwtSessionTokens/);
  assert.match(main, /auth,/);
  assert.doesNotMatch(main, /x-test-actor|AUTH_DISABLED|dev-user|hardcoded/i);
  assert.doesNotMatch(presentation, /x-test-actor/);
  assert.doesNotMatch(application, /from ["']argon2["']|from ["']jose["']/);
  assert.doesNotMatch(domain, /from ["']argon2["']|from ["']jose["']/);
  const authController = readFileSync(
    path.join(root, "apps/api/src/presentation/auth.controller.ts"),
    "utf8",
  );
  assert.doesNotMatch(authController, /roleOf\(|role ===/);
});

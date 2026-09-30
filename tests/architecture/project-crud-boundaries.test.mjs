import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function sourceFiles(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(fullPath));
    } else if (entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function readTree(relativeDirectory) {
  return sourceFiles(path.join(root, relativeDirectory)).map((file) => readFileSync(file, "utf8"));
}

test("Project CRUD keeps SQL and the repository adapter behind the port", () => {
  const domain = readTree("packages/domain/src").join("\n");
  const application = readTree("apps/api/src/application").join("\n");
  const presentation = readTree("apps/api/src/presentation").join("\n");
  const controller = readFileSync(
    path.join(root, "apps/api/src/presentation/projects.controller.ts"),
    "utf8",
  );
  const adapter = readFileSync(
    path.join(root, "apps/api/src/infrastructure/postgres-project-repository.ts"),
    "utf8",
  );
  const main = readFileSync(path.join(root, "apps/api/src/main.ts"), "utf8");

  assert.doesNotMatch(domain, /from ["']pg["']/);
  assert.doesNotMatch(application, /from ["']pg["']/);
  assert.doesNotMatch(presentation, /from ["']pg["']/);
  assert.doesNotMatch(presentation, /postgres-project-repository/);
  assert.doesNotMatch(controller, /x-user-id|x-test-actor|headers\[/);
  assert.doesNotMatch(controller, /role === |roleOf\(/);
  assert.match(adapter, /implements ProjectRepository/);
  assert.match(adapter, /Project\.restore/);
  assert.match(main, /PostgresProjectRepository/);
  assert.match(main, /createApiApplication/);
});

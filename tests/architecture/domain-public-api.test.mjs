import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiPackage = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../apps/api/package.json",
);
const require = createRequire(apiPackage);

test("a workspace consumer imports Project from the package root", () => {
  const domain = require("@editagent/domain");
  assert.equal(typeof domain.Project, "function");
  assert.equal(domain.Project.name, "Project");
  assert.equal(typeof domain.User, "function");
  assert.equal(typeof domain.MediaAsset, "function");
  assert.equal(typeof domain.Job, "function");
  const owner = domain.userId("018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f");
  const project = domain.Project.create(
    domain.projectId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f"),
    "Launch",
    owner,
    1n,
  );
  assert.equal(project.roleOf(owner), "owner");
});

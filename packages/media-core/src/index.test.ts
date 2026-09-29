import assert from "node:assert/strict";
import { test } from "node:test";
import { mediaCorePackageName } from "./index.js";

test("media-core package name is stable", () => {
  assert.equal(mediaCorePackageName, "@editagent/media-core");
});

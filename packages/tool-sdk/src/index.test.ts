import assert from "node:assert/strict";
import { test } from "node:test";
import { toolSdkPackageName } from "./index.js";

test("tool sdk package name is stable", () => {
  assert.equal(toolSdkPackageName, "@editagent/tool-sdk");
});

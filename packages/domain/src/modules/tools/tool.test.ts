import assert from "node:assert/strict";
import { test } from "vitest";
import { DomainError } from "../../kernel/error.js";
import { toolId } from "../../kernel/id.js";
import { Tool } from "./tool.js";

test("a Tool cannot declare a shell permission", () => {
  const tool = Tool.create(toolId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f"));
  assert.equal(tool.shellPermission, false);
  assert.equal(Tool.name, "Tool");
  assert.throws(() => Tool.create(tool.id, true), DomainError);
});

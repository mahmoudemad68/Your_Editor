import assert from "node:assert/strict";
import { test } from "node:test";
import { instant, uuidV7 } from "@editagent/domain";
import { NodeProjectIdGenerator } from "./node-project-id-generator.js";

test("NodeProjectIdGenerator mints a UUIDv7", () => {
  const id = new NodeProjectIdGenerator().next(instant(1_700_000_000_000n));
  assert.equal(id, uuidV7(id));
  assert.equal(id.charAt(14), "7");
});

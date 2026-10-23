import assert from "node:assert/strict";
import { test } from "node:test";
import {
  editingBody,
  EDITING_UUID,
  EDITING_HASH,
  EDITING_TIME,
  EDITING_REQUEST,
} from "./editing-body.js";
const id = "018f6b6e-7c3a-7000-8000-000000000001";
test("editing bodies admit only exact bounded fields and canonical values", () => {
  assert.deepEqual(
    editingBody(
      { clipId: id, startUs: "0", endUs: "1000000" },
      {
        clipId: EDITING_UUID,
        startUs: EDITING_TIME,
        endUs: EDITING_TIME,
      },
    ),
    { clipId: id, startUs: "0", endUs: "1000000" },
  );
  for (const body of [
    null,
    [],
    {},
    { clipId: id, actorId: id },
    { clipId: id + "\n" },
    { clipId: "../source" },
    { clipId: 3 },
  ])
    assert.throws(() => editingBody(body, { clipId: EDITING_UUID }), /Invalid editing parameters/);
  for (const [pattern, invalid] of [
    [EDITING_TIME, "01"],
    [EDITING_TIME, "1e6"],
    [EDITING_TIME, "100\n"],
    [EDITING_HASH, "a".repeat(64) + "\n"],
    [EDITING_REQUEST, "req_" + "a".repeat(32) + "\n"],
  ] as const)
    assert.throws(() => editingBody({ value: invalid }, { value: pattern }));
});

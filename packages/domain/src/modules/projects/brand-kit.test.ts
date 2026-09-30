import assert from "node:assert/strict";
import { test } from "node:test";
import { brandKitId, projectId } from "../../kernel/id.js";
import { BrandKit } from "./brand-kit.js";

test("BrandKit rejects updatedAt before createdAt", () => {
  const id = brandKitId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f");
  const ownerProject = projectId("018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f");
  assert.equal(new BrandKit(id, ownerProject, 10n, 10n).updatedAt, 10n);
  assert.throws(() => new BrandKit(id, ownerProject, 10n, 9n), /createdAt must be less than/);
  assert.throws(() => new BrandKit(id, ownerProject, "10", "9"), /createdAt must be less than/);
});

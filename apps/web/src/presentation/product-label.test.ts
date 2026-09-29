import assert from "node:assert/strict";
import { test } from "node:test";
import { productLabel } from "./product-label";

test("the web shell labels the product", () => {
  assert.equal(productLabel(), "EditAgent");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { ForbiddenException } from "@nestjs/common";
import { assertTrustedLoginOrigin } from "./login-origin.js";

const TRUSTED = ["http://app.example"];

test("a cross-site or untrusted origin is refused and forwarded host is ignored", () => {
  assert.throws(
    () =>
      assertTrustedLoginOrigin(
        { "sec-fetch-site": "cross-site", origin: "http://app.example" },
        TRUSTED,
      ),
    ForbiddenException,
  );
  assert.throws(
    () =>
      assertTrustedLoginOrigin(
        {
          origin: "https://evil.example",
          "x-forwarded-host": "app.example",
          "x-forwarded-proto": "https",
        },
        TRUSTED,
      ),
    ForbiddenException,
  );
  assert.doesNotThrow(() =>
    assertTrustedLoginOrigin(
      { origin: "http://app.example", "sec-fetch-site": "same-site" },
      TRUSTED,
    ),
  );
  assert.doesNotThrow(() => assertTrustedLoginOrigin(undefined, TRUSTED));
});

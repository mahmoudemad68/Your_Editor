import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  parseValidationPolicy,
  validationPolicySignature,
  assertInspectionTimeoutBudget,
  MEDIA_INSPECT_TIMEOUT_MS,
  MEDIA_INSPECT_OPERATIONAL_HEADROOM_MS,
  VIDEO_CODECS,
  AUDIO_CODECS,
  type ValidationPolicy,
} from "./media-validation-policy.js";

test("production inspection deadline reserves real operational headroom even at maximum inner budgets", () => {
  for (const env of [
    {},
    { MEDIA_VALIDATION_PROBE_TIMEOUT_MS: "60000", MEDIA_VALIDATION_DECODE_TIMEOUT_MS: "60000" },
  ]) {
    const policy = parseValidationPolicy(env);
    assert.ok(MEDIA_INSPECT_OPERATIONAL_HEADROOM_MS >= 150_000);
    assert.ok(
      MEDIA_INSPECT_TIMEOUT_MS >
        policy.probeTimeoutMs + policy.decodeTimeoutMs + MEDIA_INSPECT_OPERATIONAL_HEADROOM_MS,
    );
    assert.ok(MEDIA_INSPECT_TIMEOUT_MS <= 300_000);
  }
  assert.throws(() => parseValidationPolicy({ MEDIA_VALIDATION_PROBE_TIMEOUT_MS: "60001" }));
  assert.throws(() => parseValidationPolicy({ MEDIA_VALIDATION_DECODE_TIMEOUT_MS: "60001" }));
  assert.throws(() =>
    assertInspectionTimeoutBudget({
      ...parseValidationPolicy({}),
      probeTimeoutMs: 150000,
      decodeTimeoutMs: 150000,
    }),
  );
});

test("canonical shared policy preserves existing signatures and invalidates only actual policy changes", () => {
  const policy = parseValidationPolicy({});
  const historical = createHash("sha256")
    .update(
      JSON.stringify({
        version: "us127-v1",
        containers: ["mp4", "mov", "mkv", "webm"],
        video: VIDEO_CODECS,
        audio: AUDIO_CODECS,
        decode: { seconds: 1, frames: 30, threads: 2 },
        ...policy,
      }),
    )
    .digest("hex");
  assert.equal(validationPolicySignature(policy), historical);
  const reordered = Object.fromEntries(
    Object.entries(policy).reverse(),
  ) as unknown as ValidationPolicy;
  assert.equal(validationPolicySignature(reordered), historical);
  assert.notEqual(
    validationPolicySignature(parseValidationPolicy({ MEDIA_VALIDATION_MAX_BITRATE: "110000000" })),
    historical,
  );
});

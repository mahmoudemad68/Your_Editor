import { test, expect } from "vitest";
import { mediaValidation } from "./media-validation.js";
import { uploadPartBytes } from "./upload-session.js";
import { DerivedAsset, type DerivedArtifact } from "./derived-asset.js";

const ID = "018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f";
const SHA = "a".repeat(64);
test("validation verdict requires complete trusted source/policy/time and known public code", () => {
  const validated = {
    status: "validated",
    policySignature: SHA,
    sourceSha256: SHA,
    checkedAt: 100n,
    rejectionCode: null,
  };
  expect(mediaValidation(validated).status).toBe("validated");
  expect(
    mediaValidation({ ...validated, status: "rejected", rejectionCode: "corrupt_media" })
      .rejectionCode,
  ).toBe("corrupt_media");
  for (const invalid of [
    { ...validated, status: "unknown" },
    { ...validated, policySignature: null },
    { ...validated, sourceSha256: "not-sha" },
    { ...validated, checkedAt: null },
    { ...validated, rejectionCode: "corrupt_media" },
    { ...validated, status: "rejected", rejectionCode: "raw stderr" },
  ])
    expect(() => mediaValidation(invalid)).toThrow();
  expect(mediaValidation().status).toBe("pending");
});
test("multipart boundaries return actual final-part size and reject nonexistent parts", () => {
  expect(uploadPartBytes(25, 10, 1)).toBe(10);
  expect(uploadPartBytes(25, 10, 3)).toBe(5);
  for (const part of [0, -1, 4, 1.5, NaN]) expect(() => uploadPartBytes(25, 10, part)).toThrow();
  expect(() => uploadPartBytes(10001, 1, 1)).toThrow();
});
test("derived artifacts remain tied to project/source/signature/kind and deep immutable", () => {
  const artifact: DerivedArtifact = {
    projectId: ID,
    storageKey: `projects/${ID}/derived/${ID}/proxy/${SHA}/proxy.mp4`,
    parameterSignature: SHA,
    mimeType: "video/mp4",
    byteSize: "42",
    sha256: SHA,
    metadata: { variant: "proxy", parameters: { nested: { scale: 720 } } },
  };
  const restored = DerivedAsset.restore({
    id: ID,
    mediaAssetId: ID,
    kind: "proxy",
    createdAt: 100n,
    updatedAt: 101n,
    artifact,
  });
  expect(restored.toSnapshot().artifact).toEqual(artifact);
  expect(Object.isFrozen(restored.artifact?.metadata["parameters"])).toBe(true);
  for (const invalid of [
    { ...artifact, sha256: "bad" },
    { ...artifact, storageKey: `projects/${ID}/other.mp4` },
    { ...artifact, byteSize: "0" },
    { ...artifact, byteSize: "68719476737" },
    { ...artifact, mimeType: "image/jpeg" },
    { ...artifact, metadata: { variant: "poster", parameters: {} } },
  ])
    expect(() => new DerivedAsset(ID, ID, "proxy", 100n, 100n, invalid)).toThrow();
});

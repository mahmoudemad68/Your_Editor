import assert from "node:assert/strict";
import { test } from "node:test";
import { instant } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import { derivedAssetId, mediaAssetId, projectId } from "../../kernel/id.js";
import { DerivedAsset } from "./derived-asset.js";
import { Audio, Image, MediaAsset, Video } from "./media-asset.js";

const NOW = instant(1_700_000_000_000n);
const ASSET = mediaAssetId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f");
const PROJECT = projectId("018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f");

test("MediaAsset subtypes are video, audio, and image", () => {
  const video = MediaAsset.create({ id: ASSET, projectId: PROJECT, kind: "video", createdAt: NOW });
  const audio = MediaAsset.create({ id: ASSET, projectId: PROJECT, kind: "audio", createdAt: NOW });
  const image = MediaAsset.create({ id: ASSET, projectId: PROJECT, kind: "image", createdAt: NOW });
  assert.equal(video instanceof Video, true);
  assert.equal(audio instanceof Audio, true);
  assert.equal(image instanceof Image, true);
  assert.equal(video instanceof MediaAsset, true);
  assert.equal(MediaAsset.name, "MediaAsset");
  assert.equal(Video.name, "Video");
  assert.equal(Audio.name, "Audio");
  assert.equal(Image.name, "Image");
});

test("MediaAsset rejects an unknown subtype and an over-limit duration", () => {
  assert.throws(
    () => MediaAsset.create({ id: ASSET, projectId: PROJECT, kind: "file", createdAt: NOW }),
    DomainError,
  );
  assert.throws(
    () =>
      MediaAsset.create({
        id: ASSET,
        projectId: PROJECT,
        kind: "video",
        createdAt: NOW,
        duration: 1_800_000_001n,
      }),
    /1,800,000,000/,
  );
  const atLimit = MediaAsset.create({
    id: ASSET,
    projectId: PROJECT,
    kind: "video",
    createdAt: NOW,
    duration: 1_800_000_000n,
  });
  assert.equal(atLimit.duration, 1_800_000_000n);
});

test("direct Video, Audio, and Image constructors enforce the duration invariant", () => {
  for (const Subtype of [Video, Audio, Image]) {
    assert.equal(new Subtype(ASSET, PROJECT, NOW, 1_800_000_000n).duration, 1_800_000_000n);
    assert.throws(() => new Subtype(ASSET, PROJECT, NOW, 1_800_000_001n), DomainError);
    assert.throws(() => new Subtype(ASSET, PROJECT, NOW, -1n));
    assert.throws(() => new Subtype(ASSET, PROJECT, NOW, "1.5"));
    assert.throws(() => new Subtype(ASSET, PROJECT, -1n, null));
    assert.throws(() => new Subtype(ASSET, PROJECT, "1.5", null));
    assert.throws(() => new Subtype(ASSET, PROJECT, 20n, null, 10n), /createdAt must be less than/);
  }
  assert.throws(
    () =>
      MediaAsset.restore({
        id: ASSET,
        projectId: PROJECT,
        kind: "video",
        duration: null,
        createdAt: "20",
        updatedAt: "10",
      }),
    /createdAt must be less than/,
  );
});

test("MediaAsset restore keeps subtype, duration, and distinct audit timestamps", () => {
  const restored = MediaAsset.restore({
    id: ASSET,
    projectId: PROJECT,
    kind: "audio",
    duration: 1500n,
    createdAt: 10n,
    updatedAt: 25n,
  });
  assert.equal(restored instanceof Audio, true);
  assert.equal(restored.duration, 1500n);
  assert.equal(restored.createdAt, 10n);
  assert.equal(restored.updatedAt, 25n);
  assert.throws(
    () =>
      MediaAsset.restore({
        id: ASSET,
        projectId: PROJECT,
        kind: "video",
        duration: 1_800_000_001n,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    DomainError,
  );
});

test("DerivedAsset is not created as a MediaAsset kind", () => {
  const derived = DerivedAsset.create(
    derivedAssetId("018f6b6e-7c3a-7444-8d3e-9c0b1a2d3e4f"),
    ASSET,
    "thumbnail",
    NOW,
  );
  assert.equal(derived.kind, "thumbnail");
  assert.equal(DerivedAsset.name, "DerivedAsset");
  assert.throws(() => DerivedAsset.create(derived.id, ASSET, "video", NOW), DomainError);
  assert.throws(() => new DerivedAsset(derived.id, ASSET, "video", NOW), DomainError);
  const restored = DerivedAsset.restore({
    id: derived.id,
    mediaAssetId: ASSET,
    kind: "proxy",
    createdAt: 3n,
    updatedAt: 9n,
  });
  assert.equal(restored.kind, "proxy");
  assert.equal(restored.createdAt, 3n);
  assert.equal(restored.updatedAt, 9n);
  assert.throws(
    () =>
      DerivedAsset.restore({
        id: derived.id,
        mediaAssetId: ASSET,
        kind: "clip",
        createdAt: 3n,
        updatedAt: 9n,
      }),
    DomainError,
  );
  assert.throws(
    () => new DerivedAsset(derived.id, ASSET, "proxy", 20n, 10n),
    /createdAt must be less than/,
  );
  assert.throws(
    () =>
      DerivedAsset.restore({
        id: derived.id,
        mediaAssetId: ASSET,
        kind: "proxy",
        createdAt: "20",
        updatedAt: "10",
      }),
    /createdAt must be less than/,
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { instant } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import { mediaAssetId, projectId } from "../../kernel/id.js";
import { Audio, Image, MediaAsset, Video } from "./media-asset.js";
import { type ProbeResult } from "./media-probe.js";

const NOW = instant(1_700_000_000_000n);
const LATER = instant(1_700_000_000_050n);
const ASSET = mediaAssetId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f");
const PROJECT = projectId("018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f");

function rotatedProbe(): ProbeResult {
  return {
    container: "MOV",
    videoCodec: "h264",
    audioCodec: "aac",
    width: 1920,
    height: 1080,
    displayWidth: 1080,
    displayHeight: 1920,
    rotation: 90,
    frameRate: { numerator: 30000n, denominator: 1001n },
    frameRateMode: "constant",
    duration: 1_000_000n,
    colorSpace: null,
    audioChannels: 2,
    sampleRate: 48000,
    streams: [
      {
        codecType: "video",
        codecName: "h264",
        width: 1920,
        height: 1080,
        sampleRate: null,
        channels: null,
      },
      {
        codecType: "audio",
        codecName: "aac",
        width: null,
        height: null,
        sampleRate: 48000,
        channels: 2,
      },
    ],
  };
}

test("an uploaded MediaAsset stays pending with a null duration", () => {
  const asset = MediaAsset.createUploaded({
    id: ASSET,
    projectId: PROJECT,
    createdAt: NOW,
    displayFilename: "lecture.mp4",
    mimeType: "video/mp4",
    byteSize: 32,
    contentSha256: "ab".repeat(32),
  });
  assert.equal(asset.inspectionStatus, "pending");
  assert.equal(asset.duration, null);
  assert.equal(asset.videoCodec, null);
  assert.equal(asset.container, null);
  assert.equal(asset.inspectionError, null);
  assert.equal(asset.frameRateMode, null);
});

test("successful inspection stores rational metadata and swaps a 90 degree display", () => {
  const uploaded = MediaAsset.createUploaded({
    id: ASSET,
    projectId: PROJECT,
    createdAt: NOW,
    displayFilename: "upright.mov",
    mimeType: "video/quicktime",
    byteSize: 32,
    contentSha256: "cd".repeat(32),
  });
  const inspected = uploaded.recordInspection(rotatedProbe(), LATER);
  assert.equal(inspected instanceof Video, true);
  assert.equal(inspected.inspectionStatus, "completed");
  assert.equal(inspected.duration, 1_000_000n);
  assert.equal(inspected.width, 1920);
  assert.equal(inspected.height, 1080);
  assert.equal(inspected.displayWidth, 1080);
  assert.equal(inspected.displayHeight, 1920);
  assert.equal(inspected.rotation, 90);
  assert.equal(inspected.frameRateNumerator, 30000n);
  assert.equal(inspected.frameRateDenominator, 1001n);
  assert.equal(inspected.storageKey, uploaded.storageKey);
  const restored = MediaAsset.restore(inspected.toSnapshot());
  assert.equal(restored instanceof Video, true);
  assert.equal(restored.displayWidth, 1080);
  assert.equal(restored.frameRateNumerator, 30000n);
  assert.equal(restored.duration, 1_000_000n);
  assert.equal(restored.inspectionStatus, "completed");
});

test("a missing probe duration does not invent zero", () => {
  const uploaded = MediaAsset.createUploaded({
    id: ASSET,
    projectId: PROJECT,
    createdAt: NOW,
    displayFilename: "still.mp4",
    mimeType: "video/mp4",
    byteSize: 32,
    contentSha256: "ef".repeat(32),
  });
  const inspected = uploaded.recordInspection({ ...rotatedProbe(), duration: null }, LATER);
  assert.equal(inspected.duration, null);
  assert.equal(inspected.inspectionStatus, "completed");
});

test("inspection failure keeps the upload and does not invent codecs", () => {
  const uploaded = MediaAsset.createUploaded({
    id: ASSET,
    projectId: PROJECT,
    createdAt: NOW,
    displayFilename: "broken.mp4",
    mimeType: "video/mp4",
    byteSize: 32,
    contentSha256: "11".repeat(32),
  });
  const failed = uploaded.recordInspectionFailure("invalid_json", LATER);
  assert.equal(failed.inspectionStatus, "failed");
  assert.equal(failed.inspectionError, "invalid_json");
  assert.equal(failed.duration, null);
  assert.equal(failed.videoCodec, null);
  assert.equal(failed.storageKey, uploaded.storageKey);
  assert.equal(failed.uploadState, "uploaded");
  const restored = MediaAsset.restore(failed.toSnapshot());
  assert.equal(restored.inspectionStatus, "failed");
  assert.equal(restored.videoCodec, null);
});

test("a later probe failure does not erase completed metadata", () => {
  const uploaded = MediaAsset.createUploaded({
    id: ASSET,
    projectId: PROJECT,
    createdAt: NOW,
    displayFilename: "kept.mp4",
    mimeType: "video/mp4",
    byteSize: 32,
    contentSha256: "22".repeat(32),
  });
  const inspected = uploaded.recordInspection(rotatedProbe(), LATER);
  const again = inspected.recordInspectionFailure("timeout", instant(1_700_000_000_080n));
  assert.equal(again, inspected);
  assert.equal(again.videoCodec, "h264");
  assert.equal(again.inspectionStatus, "completed");
  assert.equal(again.duration, 1_000_000n);
});

test("inspection rejects backwards time, bad rotation, and a zero rational denominator", () => {
  const uploaded = MediaAsset.createUploaded({
    id: ASSET,
    projectId: PROJECT,
    createdAt: NOW,
    displayFilename: "clip.mp4",
    mimeType: "video/mp4",
    byteSize: 32,
    contentSha256: "33".repeat(32),
  });
  assert.throws(() => uploaded.recordInspection(rotatedProbe(), instant(10n)), /backwards/);
  assert.throws(
    () => uploaded.recordInspection({ ...rotatedProbe(), rotation: 45 }, LATER),
    DomainError,
  );
  assert.throws(
    () =>
      uploaded.recordInspection(
        { ...rotatedProbe(), frameRate: { numerator: 30000n, denominator: 0n } },
        LATER,
      ),
    DomainError,
  );
  assert.throws(
    () =>
      MediaAsset.restore({
        ...uploaded.toSnapshot(),
        inspectionStatus: "failed",
        inspectionError: "stderr",
      }),
    DomainError,
  );
});

test("audio and image inspections keep their subtype", () => {
  const audio = new Audio(ASSET, PROJECT, NOW, null).recordInspection(
    {
      ...rotatedProbe(),
      container: "WAV",
      videoCodec: null,
      audioCodec: "pcm_s16le",
      width: null,
      height: null,
      displayWidth: null,
      displayHeight: null,
      rotation: null,
      frameRate: null,
      frameRateMode: "unknown",
      streams: [
        {
          codecType: "audio",
          codecName: "pcm_s16le",
          width: null,
          height: null,
          sampleRate: 44100,
          channels: 1,
        },
      ],
    },
    LATER,
  );
  const image = new Image(ASSET, PROJECT, NOW, null).recordInspection(
    {
      ...rotatedProbe(),
      container: "PNG",
      videoCodec: "png",
      audioCodec: null,
      width: 64,
      height: 48,
      displayWidth: 64,
      displayHeight: 48,
      rotation: null,
      audioChannels: null,
      sampleRate: null,
      streams: [
        {
          codecType: "video",
          codecName: "png",
          width: 64,
          height: 48,
          sampleRate: null,
          channels: null,
        },
      ],
    },
    LATER,
  );
  assert.equal(audio instanceof Audio, true);
  assert.equal(image instanceof Image, true);
  assert.equal(audio.audioCodec, "pcm_s16le");
  assert.equal(image.displayWidth, 64);
});

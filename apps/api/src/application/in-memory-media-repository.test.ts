import assert from "node:assert/strict";
import { test } from "node:test";
import {
  instant,
  MediaAsset,
  mediaAssetId,
  MediaInspectionConflict,
  projectId,
  type ProbeResult,
} from "@editagent/domain";
import { InMemoryMediaAssetRepository } from "./in-memory-media-repository.js";

const T = instant(1_700_000_000_000n);
const ASSET = mediaAssetId("018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4f");
const PROJECT = projectId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f");

function pending(): MediaAsset {
  return MediaAsset.createUploaded({
    id: ASSET,
    projectId: PROJECT,
    createdAt: T,
    displayFilename: "clip.mp4",
    mimeType: "video/mp4",
    byteSize: 32,
    contentSha256: "ab".repeat(32),
  });
}

function probe(codec: string, duration: bigint = 1_000_000n): ProbeResult {
  return {
    container: "MP4",
    videoCodec: codec,
    audioCodec: null,
    width: 320,
    height: 240,
    displayWidth: 320,
    displayHeight: 240,
    rotation: null,
    frameRate: { numerator: 25n, denominator: 1n },
    frameRateMode: "constant",
    duration,
    colorSpace: null,
    audioChannels: null,
    sampleRate: null,
    streams: [
      {
        codecType: "video",
        codecName: codec,
        width: 320,
        height: 240,
        sampleRate: null,
        channels: null,
      },
    ],
  };
}

test("in-memory inspection revision rejects a same-timestamp second writer", async () => {
  const media = new InMemoryMediaAssetRepository();
  await media.save(pending());
  const first = await media.loadForInspection(ASSET);
  const second = await media.loadForInspection(ASSET);
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.revision, 0n);
  assert.equal(second.revision, 0n);
  const winner = first.asset.recordInspection(probe("h264"), T);
  const loser = second.asset.recordInspection(probe("hevc", 2_000_000n), T);
  assert.equal(winner.updatedAt, loser.updatedAt);
  await media.saveInspection(winner, first.revision);
  await assert.rejects(() => media.saveInspection(loser, second.revision), MediaInspectionConflict);
  const stored = await media.loadForInspection(ASSET);
  assert.ok(stored);
  assert.equal(stored.revision, 1n);
  assert.equal(stored.asset.videoCodec, "h264");
  assert.equal(stored.asset.duration, 1_000_000n);
  assert.equal(stored.asset.inspectionStatus, "completed");
  assert.equal(stored.asset.inspectionError, null);
  const read = await media.findById(ASSET);
  assert.equal((await media.loadForInspection(ASSET))?.revision, 1n);
  assert.equal(read?.videoCodec, "h264");
});

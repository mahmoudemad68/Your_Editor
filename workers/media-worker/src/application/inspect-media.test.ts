import assert from "node:assert/strict";
import { test } from "node:test";
import {
  instant,
  type Instant,
  MediaAsset,
  mediaAssetId,
  MediaInspectionConflict,
  MediaProbeError,
  projectId,
  type ProbeResult,
} from "@editagent/domain";
import { inspectMediaAsset, type MediaObjectStaging } from "./inspect-media.js";

const NOW = instant(1_700_000_000_000n);
const LATER = instant(1_700_000_000_050n);
const ASSET = mediaAssetId("018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4f");
const PROJECT = projectId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f");

function uploaded(): MediaAsset {
  return MediaAsset.createUploaded({
    id: ASSET,
    projectId: PROJECT,
    createdAt: NOW,
    displayFilename: "../../etc/passwd",
    mimeType: "video/mp4",
    byteSize: 32,
    contentSha256: "ab".repeat(32),
  });
}

function probeResult(): ProbeResult {
  return {
    container: "MP4",
    videoCodec: "h264",
    audioCodec: "aac",
    width: 320,
    height: 240,
    displayWidth: 320,
    displayHeight: 240,
    rotation: null,
    frameRate: { numerator: 25n, denominator: 1n },
    frameRateMode: "constant",
    duration: 1_000_000n,
    colorSpace: null,
    audioChannels: 1,
    sampleRate: 48000,
    streams: [
      {
        codecType: "video",
        codecName: "h264",
        width: 320,
        height: 240,
        sampleRate: null,
        channels: null,
      },
    ],
  };
}

function repository(initial: MediaAsset): {
  readonly saves: MediaAsset[];
  findById(): Promise<MediaAsset | null>;
  saveInspection(asset: MediaAsset, expectedUpdatedAt: Instant): Promise<void>;
} {
  let current = initial;
  const saves: MediaAsset[] = [];
  return {
    saves,
    async findById() {
      return current;
    },
    async saveInspection(asset, expectedUpdatedAt) {
      if (current.updatedAt !== expectedUpdatedAt) {
        throw new MediaInspectionConflict();
      }
      current = asset;
      saves.push(asset);
    },
  };
}

function staging(released: { value: boolean }): MediaObjectStaging {
  return {
    async stage(storageKey) {
      assert.equal(storageKey.includes("passwd"), false);
      assert.equal(storageKey.endsWith("source.bin"), false);
      return {
        filePath: "/tmp/editagent-probe-test/source.bin",
        release: async () => {
          released.value = true;
        },
      };
    },
  };
}

test("inspection persists probe metadata and releases the temporary file", async () => {
  const media = repository(uploaded());
  const released = { value: false };
  const asset = await inspectMediaAsset(ASSET, {
    media,
    staging: staging(released),
    probe: {
      async inspect() {
        return probeResult();
      },
    },
    clock: { now: () => LATER },
  });
  assert.equal(asset.inspectionStatus, "completed");
  assert.equal(asset.duration, 1_000_000n);
  assert.equal(asset.videoCodec, "h264");
  assert.equal(released.value, true);
  assert.equal(media.saves.length, 1);
});

test("probe and staging failures are stored without deleting metadata or crashing", async () => {
  const media = repository(uploaded());
  const released = { value: false };
  const failed = await inspectMediaAsset(ASSET, {
    media,
    staging: staging(released),
    probe: {
      async inspect() {
        throw new MediaProbeError("timeout");
      },
    },
    clock: { now: () => LATER },
  });
  assert.equal(failed.inspectionStatus, "failed");
  assert.equal(failed.inspectionError, "timeout");
  assert.equal(failed.duration, null);
  assert.equal(failed.videoCodec, null);
  assert.equal(failed.storageKey, uploaded().storageKey);
  assert.equal(released.value, true);

  const missing = repository(uploaded());
  const missingResult = await inspectMediaAsset(ASSET, {
    media: missing,
    staging: {
      async stage() {
        throw new MediaProbeError("object_missing");
      },
    },
    probe: {
      async inspect() {
        return probeResult();
      },
    },
    clock: { now: () => LATER },
  });
  assert.equal(missingResult.inspectionError, "object_missing");
  assert.equal(missingResult.inspectionStatus, "failed");
  assert.equal(missing.saves.length, 1);
});

test("a failed probe does not overwrite completed metadata", async () => {
  const completed = uploaded().recordInspection(probeResult(), LATER);
  const media = repository(completed);
  const released = { value: false };
  const result = await inspectMediaAsset(ASSET, {
    media,
    staging: staging(released),
    probe: {
      async inspect() {
        throw new MediaProbeError("exit");
      },
    },
    clock: { now: () => instant(1_700_000_000_080n) },
  });
  assert.equal(result.inspectionStatus, "completed");
  assert.equal(result.videoCodec, "h264");
  assert.equal(media.saves.length, 0);
  assert.equal(released.value, true);
});

test("a stale inspection conflict is reported and the temporary file is released", async () => {
  const media = repository(uploaded());
  const released = { value: false };
  media.saveInspection = async () => {
    throw new MediaInspectionConflict();
  };
  await assert.rejects(
    () =>
      inspectMediaAsset(ASSET, {
        media,
        staging: staging(released),
        probe: {
          async inspect() {
            return probeResult();
          },
        },
        clock: { now: () => LATER },
      }),
    MediaInspectionConflict,
  );
  assert.equal(released.value, true);
  assert.equal(media.saves.length, 0);
});

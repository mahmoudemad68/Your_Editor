import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DerivedAsset,
  MediaAsset,
  instant,
  mediaAssetId,
  projectId,
  type ProbeResult,
} from "@editagent/domain";
import { derivativePlans, canonicalJson, parameterSignature } from "./derivative-plan.js";
import {
  deriveMediaAsset,
  type DerivationDependencies,
  type DerivationRepository,
} from "./derive-media.js";
import { PermanentJobError } from "./job-errors.js";

const id = mediaAssetId("018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4f");
const project = projectId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f");
const uploaded = () =>
  MediaAsset.createUploaded({
    id,
    projectId: project,
    createdAt: instant(1n),
    displayFilename: "../../evil;cmd.mp4",
    mimeType: "video/mp4",
    byteSize: 12,
    contentSha256: "ab".repeat(32),
  });
const metadata: ProbeResult = {
  container: "MP4",
  videoCodec: "h264",
  audioCodec: "aac",
  width: 960,
  height: 720,
  displayWidth: 960,
  displayHeight: 720,
  rotation: null,
  frameRate: { numerator: 30n, denominator: 1n },
  frameRateMode: "constant",
  duration: 1_800_000_000n,
  colorSpace: null,
  audioChannels: 2,
  sampleRate: 48000,
  streams: [
    {
      codecType: "video",
      codecName: "h264",
      width: 960,
      height: 720,
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
const source = () => uploaded().recordInspection(metadata, instant(2n));

test("uninspected media cannot derive; versioned signatures change for every relevant policy", () => {
  assert.throws(() => derivativePlans(uploaded()), PermanentJobError);
  const plans = derivativePlans(source());
  assert.equal(plans.length, 5);
  assert.equal(
    parameterSignature({ b: [{ y: 1, x: 2 }], a: "v" }),
    parameterSignature({ a: "v", b: [{ x: 2, y: 1 }] }),
  );
  const proxy = plans[0]!;
  for (const [key, value] of Object.entries({
    targetHeight: 360,
    fps: 25,
    gop: 60,
    codec: "hevc",
    pixelFormat: "yuv444p",
    preset: "slow",
    crf: 24,
    version: "v2",
  }))
    assert.notEqual(parameterSignature({ ...proxy.parameters, [key]: value }), proxy.signature);
  assert.equal(new Set(plans.map((p) => p.signature)).size, 5);
  for (const plan of plans) {
    assert.ok(plan.storageKey.startsWith(`projects/${project}/derived/${id}/`));
    assert.ok(!plan.storageKey.includes("evil"));
    assert.equal(plan.signature, parameterSignature(plan.parameters));
  }
});

test("sprite midpoint coverage and short-source plan are deterministic and recovery descriptors fit", () => {
  const sprite = derivativePlans(source()).find((p) => p.variant === "sprite")!;
  assert.equal(sprite.parameters["rows"], 4);
  assert.equal(sprite.parameters["columns"], 5);
  const points = sprite.parameters["timestampsUs"] as number[];
  assert.equal(points.length, 20);
  assert.equal(points[0], 45_000_000);
  assert.equal(points.at(-1), 1_755_000_000);
  for (const p of derivativePlans(source()))
    assert.ok(
      Buffer.byteLength(
        Buffer.from(
          canonicalJson({
            variant: p.variant,
            parameters: p.parameters,
            durationUs: "1800000000",
            width: 720,
            height: 540,
            fps: 30,
            sampleRate: 48000,
            channels: 2,
            codec: "pcm_f32le",
          }),
        ).toString("base64"),
      ) <= 1800,
    );
  const short = uploaded().recordInspection({ ...metadata, duration: 10_000n }, instant(2n));
  const image = derivativePlans(short).find((p) => p.variant === "sprite")!;
  assert.deepEqual(image.parameters["timestampsUs"], [5000]);
  assert.equal(image.parameters["rows"], 1);
  assert.equal(image.parameters["columns"], 1);
  assert.equal(
    derivativePlans(short).find((p) => p.variant === "poster")!.parameters["timestampUs"],
    3333,
  );
});

test("durable DerivedAsset restores artifact, freezes parameters and rejects keys/MIME/project conflicts", () => {
  const plan = derivativePlans(source())[0]!;
  const artifact = {
    projectId: project,
    storageKey: plan.storageKey,
    parameterSignature: plan.signature,
    mimeType: plan.mimeType,
    byteSize: "123",
    sha256: "cd".repeat(32),
    metadata: { variant: plan.variant, parameters: plan.parameters },
  };
  const asset = new DerivedAsset(id, id, plan.kind, instant(2n), undefined, artifact);
  assert.deepEqual(DerivedAsset.restore(asset.toSnapshot()).toSnapshot(), asset.toSnapshot());
  assert.throws(() =>
    Object.assign(asset.artifact!.metadata["parameters"] as object, { fps: 100 }),
  );
  for (const change of [
    { storageKey: "../evil" },
    { storageKey: "/etc/passwd" },
    { mimeType: "image/jpeg" },
    { projectId: "018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e40" },
    { byteSize: "0" },
    { sha256: "not-a-checksum" },
    { metadata: { variant: "mix", parameters: {} } },
  ])
    assert.throws(
      () => new DerivedAsset(id, id, plan.kind, instant(2n), undefined, { ...artifact, ...change }),
    );
});

test("US-127 gate runs before reuse, staging and object access; cancellation stops subsequent work", async () => {
  let touched = false;
  const never = async () => {
    touched = true;
    throw new Error("Unexpected work");
  };
  const repository: DerivationRepository = {
    loadSource: async () => source(),
    findBySignature: never,
    listByMediaAsset: never,
    save: never,
    withSourceLock: async (_id, _signal, work) => work(repository),
  };
  const deps: DerivationDependencies = {
    repository,
    objects: { find: never, put: never },
    staging: { stage: never },
    processor: { prepare: never },
    gate: {
      assertAllowed: async () => {
        throw new PermanentJobError("Validation not granted");
      },
    },
    now: () => instant(2n),
    newId: () => id,
  };
  await assert.rejects(
    deriveMediaAsset(id, project, new AbortController().signal, deps),
    /Validation not granted/,
  );
  assert.equal(touched, false);
  const cancelled = new AbortController();
  cancelled.abort(new Error("cancelled"));
  await assert.rejects(deriveMediaAsset(id, project, cancelled.signal, deps), /cancelled/);
  assert.equal(touched, false);
});

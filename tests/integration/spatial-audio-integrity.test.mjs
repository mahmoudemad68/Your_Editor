import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  prepareSpatialFixtures,
  prepareUnverifiableSpatialFixture,
  verifySpatialOutput,
} from "../../tools/render/spatial-audio-fixtures.mjs";
const { AbortController } = globalThis;
const require = createRequire(import.meta.url);
const {
  executeMediaEdit,
} = require("../../workers/render-worker/dist/infrastructure/media-edit.js");
const {
  validateOutput,
} = require("../../workers/render-worker/dist/infrastructure/probe-output.js");
for (const { rate, frames } of [
  ...[25, 30, 30000, 24000, 60000, "qa2997-l1"].map((rate) => ({ rate, frames: undefined })),
  ...[25, 30, 24000, 30000, 60000].flatMap((n) =>
    [1, 2, 3].map((frames) => ({ rate: `short-${n}`, frames })),
  ),
])
  test(
    `QA53R-2/R3: real crop/resize preserve independent clocks and content (${rate}${frames ? "/" + frames + "f" : ""})`,
    { timeout: 120000 },
    async () => {
      const work = await mkdtemp(path.join(tmpdir(), "spatial-audio-"));
      try {
        const short = typeof rate === "string" && rate.startsWith("short-");
        const fixtures = prepareSpatialFixtures(
            work,
            (p) =>
              rate === "qa2997-l1"
                ? p.relation === rate
                : p.n === (short ? Number(rate.slice(6)) : rate) &&
                  p.relation !== "qa2997-l1" &&
                  (!short || p.frames === frames),
            short,
          ),
          id = "018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f";
        for (const fixture of fixtures)
          for (const operation of ["crop_video", "resize_video"]) {
            const bytes = await readFile(fixture.file);
            const result = await executeMediaEdit(
              {
                schemaVersion: 1,
                kind: "media-edit-v1",
                renderVersion: "a".repeat(64),
                operation,
                sources: [{ id, kind: "video", durationUs: fixture.assetDurationUs }],
                parameters:
                  operation === "crop_video"
                    ? { assetId: id, x: 0, y: 0, width: 32, height: 32 }
                    : {
                        assetId: id,
                        width: fixture.shortSource ? 160 : 128,
                        height: fixture.shortSource ? 120 : 128,
                      },
              },
              [
                {
                  sourceId: id,
                  kind: "video",
                  name: path.basename(fixture.file),
                  durationUs: fixture.assetDurationUs,
                  sha256: fixture.sha256,
                  byteSize: bytes.length,
                },
              ],
              work,
              new AbortController().signal,
              () => {},
            );
            const file = path.join(work, "output.mp4");
            verifySpatialOutput(file, fixture, operation);
            assert.equal(result.audioSamples, String(fixture.samples));
            assert.equal(result.durationUs, fixture.assetDurationUs);
            assert.equal(result.sourceVideoFrames, fixture.frames);
            assert.equal(result.spatialFrameCountBasis, "decoded_cfr_v1");
            assert.equal(
              createHash("sha256")
                .update(await readFile(fixture.file))
                .digest("hex"),
              fixture.sha256,
            );
            if (fixture.relation === "qa2997-l1") {
              const truncated = path.join(work, "truncated.mp4");
              execFileSync(
                "ffmpeg",
                [
                  "-v",
                  "error",
                  "-y",
                  "-i",
                  file,
                  "-c:v",
                  "copy",
                  "-af",
                  "atrim=end_sample=286686",
                  "-c:a",
                  "aac",
                  "-ar",
                  "48000",
                  "-ac",
                  "2",
                  truncated,
                ],
                { timeout: 15000 },
              );
              const input = {
                schemaVersion: 1,
                renderVersion: "a".repeat(64),
                compositionId: "FixtureV1",
                correlationId: "test",
                width: operation === "crop_video" ? 32 : 128,
                height: operation === "crop_video" ? 32 : 128,
                frameRate: { numerator: fixture.n, denominator: fixture.d },
                durationInFrames: 179,
                props: { title: "test", background: "#000000" },
              };
              await assert.rejects(
                validateOutput(truncated, input, undefined, true, 310656n),
                /audio duration/,
              );
            }
          }
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  );

test(
  "QA53R-3: real non-CFR source fails closed before crop/resize output exists",
  { timeout: 30000 },
  async () => {
    const work = await mkdtemp(path.join(tmpdir(), "spatial-invalid-"));
    try {
      const fixture = prepareUnverifiableSpatialFixture(work),
        id = "018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f";
      for (const operation of ["crop_video", "resize_video"]) {
        await assert.rejects(
          executeMediaEdit(
            {
              schemaVersion: 1,
              kind: "media-edit-v1",
              renderVersion: "a".repeat(64),
              operation,
              sources: [{ id, kind: "video", durationUs: fixture.assetDurationUs }],
              parameters:
                operation === "crop_video"
                  ? { assetId: id, x: 0, y: 0, width: 32, height: 32 }
                  : { assetId: id, width: 160, height: 120 },
            },
            [
              {
                sourceId: id,
                kind: "video",
                name: path.basename(fixture.file),
                durationUs: fixture.assetDurationUs,
                sha256: fixture.sha256,
                byteSize: 1,
              },
            ],
            work,
            new AbortController().signal,
            () => {},
          ),
          (e) =>
            e.name === "MediaEditInputError" && e.message === "Unsupported media editing input.",
        );
        await assert.rejects(readFile(path.join(work, "output.mp4")), { code: "ENOENT" });
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);

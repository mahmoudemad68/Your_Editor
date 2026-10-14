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
for (const rate of [25, 30, 30000, 24000, 60000, "qa2997-l1"])
  test(
    `QA53R-2: real crop/resize preserve independent audio clocks and content (${rate})`,
    { timeout: 120000 },
    async () => {
      const work = await mkdtemp(path.join(tmpdir(), "spatial-audio-"));
      try {
        const fixtures = prepareSpatialFixtures(work, (p) =>
            rate === "qa2997-l1" ? p.relation === rate : p.n === rate && p.relation !== "qa2997-l1",
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
                    : { assetId: id, width: 128, height: 128 },
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

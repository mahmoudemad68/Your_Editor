import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { type INestApplication } from "@nestjs/common";
import {
  instant,
  type Instant,
  MediaAsset,
  mediaAssetId,
  Project,
  projectId,
  userId,
} from "@editagent/domain";
import {
  type Clock,
  type MediaAssetIdGenerator,
  type ProjectIdGenerator,
} from "../application/clock.js";
import { InMemoryMediaAssetRepository } from "../application/in-memory-media-repository.js";
import { InMemoryProjectRepository } from "../application/in-memory-project-repository.js";
import { MemoryObjectStorage } from "../application/memory-object-storage.js";
import { createApiApplication } from "../create-api-application.js";
import { bindActor } from "./actor.js";

const OWNER = userId("018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f");
const EDITOR = userId("018f6b6e-7c3a-7222-8d3e-9c0b1a2d3e4f");
const VIEWER = userId("018f6b6e-7c3a-7333-8d3e-9c0b1a2d3e4f");
const STRANGER = userId("018f6b6e-7c3a-7444-8d3e-9c0b1a2d3e4f");
const PROJECT = projectId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f");
const OTHER = projectId("018f6b6e-7c3a-7b2b-8d3e-9c0b1a2d3e4f");
const ASSET = mediaAssetId("018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4f");
const OTHER_ASSET = mediaAssetId("018f6b6e-7c3a-7b2d-8d3e-9c0b1a2d3e4f");
const NOW = instant(1_700_000_000_000n);

class FixedClock implements Clock {
  now(): Instant {
    return NOW;
  }
}

class OneProjectId implements ProjectIdGenerator {
  next(): typeof PROJECT {
    return PROJECT;
  }
}

class OneMediaId implements MediaAssetIdGenerator {
  next(): typeof ASSET {
    return ASSET;
  }
}

test("media details read persisted metadata and enforce membership", async () => {
  const projects = new InMemoryProjectRepository();
  const media = new InMemoryMediaAssetRepository();
  await projects.save(
    Project.create(PROJECT, "Launch", OWNER, NOW)
      .grantMembership(OWNER, EDITOR, "editor", instant(1_700_000_000_010n))
      .grantMembership(OWNER, VIEWER, "viewer", instant(1_700_000_000_020n)),
    null,
  );
  await projects.save(Project.create(OTHER, "Other", STRANGER, NOW), null);
  const pending = MediaAsset.createUploaded({
    id: ASSET,
    projectId: PROJECT,
    createdAt: NOW,
    displayFilename: "lecture.mp4",
    mimeType: "video/mp4",
    byteSize: 32,
    contentSha256: "ab".repeat(32),
  });
  await media.save(pending);
  const failed = MediaAsset.createUploaded({
    id: OTHER_ASSET,
    projectId: OTHER,
    createdAt: NOW,
    displayFilename: "other.mp4",
    mimeType: "video/mp4",
    byteSize: 32,
    contentSha256: "cd".repeat(32),
  }).recordInspectionFailure("timeout", instant(1_700_000_000_030n));
  await media.save(failed);
  const completed = pending.recordInspection(
    {
      container: "MP4",
      videoCodec: "h264",
      audioCodec: "aac",
      width: 320,
      height: 240,
      displayWidth: 240,
      displayHeight: 320,
      rotation: 90,
      frameRate: { numerator: 30000n, denominator: 1001n },
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
    },
    instant(1_700_000_000_040n),
  );
  await media.saveInspection(completed, 0n);

  const app = await listen(projects, media);
  try {
    const anonymous = await fetch(url(app, PROJECT, ASSET));
    assert.equal(anonymous.status, 401);
    const forgedHeader = await fetch(url(app, PROJECT, ASSET), {
      headers: { "x-user-id": OWNER },
    });
    assert.equal(forgedHeader.status, 401);

    const owner = await fetch(`${url(app, PROJECT, ASSET)}?userId=${STRANGER}`, {
      headers: { "x-test-actor": OWNER },
    });
    assert.equal(owner.status, 200);
    const body = (await owner.json()) as Record<string, unknown>;
    assert.equal(body["inspectionStatus"], "completed");
    assert.equal(body["duration"], "1000000");
    assert.equal(body["displayWidth"], 240);
    assert.equal(body["displayHeight"], 320);
    assert.equal(body["frameRateNumerator"], "30000");
    assert.equal(body["frameRateDenominator"], "1001");
    assert.equal(body["storageKey"], undefined);
    assert.equal(body["inspectionRevision"], undefined);
    assert.equal(body["revision"], undefined);
    assert.equal(body["secretAccessKey"], undefined);
    assert.equal(body["stderr"], undefined);
    assert.equal(JSON.stringify(body).includes("ffprobe"), false);

    for (const actor of [EDITOR, VIEWER]) {
      const response = await fetch(url(app, PROJECT, ASSET), {
        headers: { "x-test-actor": actor },
      });
      assert.equal(response.status, 200);
    }
    assert.equal(
      (await fetch(url(app, PROJECT, ASSET), { headers: { "x-test-actor": STRANGER } })).status,
      404,
    );
    assert.equal(
      (
        await fetch(url(app, OTHER, ASSET), {
          headers: { "x-test-actor": OWNER },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(url(app, PROJECT, OTHER_ASSET), {
          headers: { "x-test-actor": OWNER },
        })
      ).status,
      404,
    );
    const hidden = await fetch(url(app, OTHER, OTHER_ASSET), {
      headers: { "x-test-actor": STRANGER },
    });
    assert.equal(hidden.status, 200);
    const hiddenBody = (await hidden.json()) as Record<string, unknown>;
    assert.equal(hiddenBody["inspectionStatus"], "failed");
    assert.equal(hiddenBody["inspectionError"], "timeout");
    assert.equal(hiddenBody["videoCodec"], null);
    assert.equal(hiddenBody["duration"], null);
    assert.equal(
      (await fetch(url(app, "not-a-uuid", ASSET), { headers: { "x-test-actor": OWNER } })).status,
      400,
    );
  } finally {
    await app.close();
  }
});

async function listen(
  projects: InMemoryProjectRepository,
  media: InMemoryMediaAssetRepository,
): Promise<INestApplication> {
  const app = await createApiApplication(
    {
      projects,
      clock: new FixedClock(),
      ids: new OneProjectId(),
      media,
      objects: new MemoryObjectStorage(),
      mediaIds: new OneMediaId(),
      presignTtlSeconds: 900,
    },
    (use) => {
      use((request, _response, next) => {
        const headers = (request as { headers?: Record<string, string | string[] | undefined> })
          .headers;
        const header = headers?.["x-test-actor"];
        if (typeof header === "string") {
          bindActor(request, userId(header));
        }
        next();
      });
    },
  );
  await app.listen(0, "127.0.0.1");
  return app;
}

function url(app: INestApplication, project: string, asset: string): string {
  const address = app.getHttpServer().address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected the test server to listen on a TCP port.");
  }
  return `http://127.0.0.1:${address.port}/projects/${project}/media/${asset}`;
}

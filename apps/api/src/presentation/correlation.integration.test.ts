/**
 * Contract check for the log payload shape.
 * The broker proof is queue-correlation.integration.test.ts.
 * This test does not reserve a BullMQ job.
 */

import "reflect-metadata";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { test } from "node:test";
import path from "node:path";
import { instant, mediaAssetId, projectId, userId } from "@editagent/domain";
import { createServiceLogger } from "@editagent/shared";

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
const PROJECT = projectId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f");
const REQUEST_ID = "web-request-1";

class ManualClock implements Clock {
  now(): ReturnType<Clock["now"]> {
    return instant(10n);
  }
}

class OneId implements ProjectIdGenerator {
  next(): typeof PROJECT {
    return PROJECT;
  }
}

class FixedMediaId implements MediaAssetIdGenerator {
  next(): ReturnType<MediaAssetIdGenerator["next"]> {
    return mediaAssetId("018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4f");
  }
}

test("an upload request id is on every API and worker job log line", async () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString("utf8"));
      callback();
    },
  });
  const objects = new MemoryObjectStorage();
  const logger = createServiceLogger("api", stream);
  const app = await createApiApplication(
    {
      projects: new InMemoryProjectRepository(),
      clock: new ManualClock(),
      ids: new OneId(),
      media: new InMemoryMediaAssetRepository(),
      objects,
      mediaIds: new FixedMediaId(),
      presignTtlSeconds: 900,
      logger,
    },
    (use) => {
      use((request, _response, next) => {
        const headers = (request as { headers?: Record<string, string | undefined> }).headers;
        const header = headers?.["x-test-actor"];
        if (typeof header === "string") {
          bindActor(request, userId(header));
        }
        next();
      });
    },
    logger,
  );
  try {
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a TCP port");
    }
    const base = `http://127.0.0.1:${address.port}`;
    const created = await fetch(`${base}/projects`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-actor": OWNER,
        "x-request-id": REQUEST_ID,
      },
      body: JSON.stringify({ name: "Launch" }),
    });
    assert.equal(created.status, 201);
    const body = Buffer.from("editagent-fixture-video");
    const hash = createHash("sha256").update(body).digest("hex");
    const started = await fetch(`${base}/projects/${PROJECT}/uploads`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-actor": OWNER,
        "x-request-id": REQUEST_ID,
      },
      body: JSON.stringify({
        filename: "lecture.mp4",
        mimeType: "video/mp4",
        byteSize: body.byteLength,
        sha256: hash,
      }),
    });
    const startedText = await started.text();
    assert.equal(started.status, 201, startedText);
    const startedBody = JSON.parse(startedText) as { storageKey: string };
    await objects.put(startedBody.storageKey, body, "video/mp4", hash);
    const completed = await fetch(`${base}/projects/${PROJECT}/uploads/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-actor": OWNER,
        "x-request-id": REQUEST_ID,
      },
      body: JSON.stringify({
        filename: "lecture.mp4",
        mimeType: "video/mp4",
        byteSize: body.byteLength,
        sha256: hash,
      }),
    });
    const completedText = await completed.text();
    assert.equal(completed.status, 201, completedText);
    assert.equal(completed.headers.get("x-request-id"), REQUEST_ID);
  } finally {
    await app.close();
  }

  const apiLines = lines.flatMap((chunk) => chunk.split("\n").filter((line) => line.length > 0));
  const accepted = apiLines
    .map(
      (line) =>
        JSON.parse(line) as {
          message?: string;
          correlationId?: string;
          subjectId?: string;
          jobType?: string;
        },
    )
    .find((line) => line.message === "job.accepted");
  assert.ok(accepted);
  assert.equal(accepted.correlationId, REQUEST_ID);
  for (const line of apiLines.map((item) => JSON.parse(item) as { correlationId?: string })) {
    assert.equal(line.correlationId, REQUEST_ID);
  }

  const worker = spawnSync(
    process.execPath,
    [
      path.resolve(__dirname, "../../../../workers/media-worker/dist/run-logged-job.js"),
      JSON.stringify({
        correlationId: accepted.correlationId,
        jobType: accepted.jobType,
        subjectId: accepted.subjectId,
      }),
    ],
    { encoding: "utf8" },
  );
  assert.equal(worker.status, 0, worker.stderr);
  const workerLines = worker.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { correlationId?: string; message?: string });
  assert.deepEqual(
    workerLines.map((line) => line.message),
    ["job.started", "job.finished"],
  );
  for (const line of workerLines) {
    assert.equal(line.correlationId, REQUEST_ID);
  }
});

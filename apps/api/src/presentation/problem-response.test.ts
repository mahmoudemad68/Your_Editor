import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import { HttpException } from "@nestjs/common";
import { bindCorrelationId, createServiceLogger } from "@editagent/shared";
import { createApiApplication } from "../create-api-application.js";
import { InMemoryProjectRepository } from "../application/in-memory-project-repository.js";
import { InMemoryMediaAssetRepository } from "../application/in-memory-media-repository.js";
import { MemoryObjectStorage } from "../application/memory-object-storage.js";
import { ObjectStorageUnavailable } from "../application/upload-errors.js";
import { instant, projectId, mediaAssetId } from "@editagent/domain";
import { ProjectExceptionFilter } from "./project-exception.filter.js";

function capturedLogger() {
  const logs: string[] = [];
  const logger = createServiceLogger(
    "api",
    new Writable({
      write(chunk, _encoding, done) {
        logs.push(chunk.toString());
        done();
      },
    }),
  );
  return { logger, logs };
}
const CANARIES = [
  "SECRET_CANARY",
  "postgresql://user:password@host/db",
  "/tmp/private/file",
  "SELECT password FROM secrets",
  "Authorization: Bearer CANARY",
  "X-Amz-Signature=CANARY",
  "Error:",
  "stack detail",
];

test("an unhandled error logs once with the response trace id and no internals", () => {
  bindCorrelationId("web-request-1");
  let statusCode = 0;
  let contentType = "";
  let body: Record<string, unknown> = {};
  const { logger, logs } = capturedLogger();
  new ProjectExceptionFilter(logger).catch(new Error(CANARIES.join("\n")), {
    switchToHttp: () => ({
      getResponse: () => ({
        status(code: number) {
          statusCode = code;
          return {
            type(value: string) {
              contentType = value;
            },
            json(payload: unknown) {
              body = payload as Record<string, unknown>;
            },
          };
        },
      }),
    }),
  } as never);
  assert.equal(statusCode, 500);
  assert.equal(contentType, "application/problem+json");
  assert.equal(body.traceId, "web-request-1");
  assert.equal(body.status, 500);
  const failures = logs.map((line) => JSON.parse(line));
  assert.equal(failures.length, 1);
  assert.deepEqual(
    {
      event: failures[0].message,
      correlation: failures[0].correlationId,
      trace: failures[0].traceId,
      status: failures[0].status,
      code: failures[0].errorCode,
    },
    {
      event: "request.failed",
      correlation: body.traceId,
      trace: body.traceId,
      status: 500,
      code: "unexpected_server_error",
    },
  );
  for (const canary of CANARIES)
    assert.equal((JSON.stringify(body) + logs.join("")).includes(canary), false);
});

test("real API logger traces unexpected/HTTP 5xx once; readiness 503 and expected 4xx stay quiet", async () => {
  const { logger, logs } = capturedLogger();
  let failure: unknown = new Error(CANARIES.join("\n"));
  // Test-only injected readiness implementation throws; no production throw route.
  // This also exercises createApiApplication's actual shared-logger/filter wiring.
  const app = await createApiApplication({
    projects: new InMemoryProjectRepository(),
    media: new InMemoryMediaAssetRepository(),
    objects: new MemoryObjectStorage(),
    clock: { now: () => instant(0n) },
    ids: { next: () => projectId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f") },
    mediaIds: { next: () => mediaAssetId("018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4f") },
    presignTtlSeconds: 900,
    logger,
    readiness: {
      async check() {
        if (failure) throw failure;
        return false;
      },
    },
  });
  try {
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    const base = `http://127.0.0.1:${address.port}`;
    for (const status of [500, 502, 503]) {
      for (const httpException of status === 500 ? [false, true] : [true]) {
        failure = httpException
          ? new HttpException(CANARIES.join("\n"), status)
          : new Error(CANARIES.join("\n"));
        const traceId = `b2-failure-${status}-${httpException}`;
        const before = logs.length;
        const reply = await fetch(`${base}/ready`, { headers: { "x-request-id": traceId } });
        assert.equal(reply.status, status);
        assert.match(reply.headers.get("content-type") ?? "", /application\/problem\+json/);
        const body = (await reply.json()) as Record<string, unknown>;
        assert.equal(body.traceId, traceId);
        const requestLogs = logs.slice(before).map((line) => JSON.parse(line));
        const failures = requestLogs.filter((line) => line.message === "request.failed");
        assert.equal(failures.length, 1);
        assert.equal(failures[0].level, "error");
        assert.equal(failures[0].correlationId, body.traceId);
        assert.equal(failures[0].traceId, body.traceId);
        assert.equal(failures[0].status, status);
        assert.equal(
          failures[0].errorCode,
          httpException ? "http_server_error" : "unexpected_server_error",
        );
        for (const canary of CANARIES)
          assert.equal(
            (JSON.stringify(body) + logs.slice(before).join("")).includes(canary),
            false,
          );
        if (!httpException) console.log("B2_FAILURE_LOG_EVIDENCE", JSON.stringify(failures[0]));
      }
    }
    for (const status of [400, 401, 403, 404, 409, 429]) {
      failure = new HttpException({ statusCode: status, message: "Expected client error" }, status);
      const before = logs.length;
      const reply = await fetch(`${base}/ready`);
      assert.equal(reply.status, status);
      assert.deepEqual(await reply.json(), {
        statusCode: status,
        message: "Expected client error",
      });
      assert.equal(
        logs.slice(before).some((line) => JSON.parse(line).message === "request.failed"),
        false,
      );
    }
    failure = undefined;
    const before = logs.length;
    const notReady = await fetch(`${base}/ready`);
    assert.equal(notReady.status, 503);
    assert.deepEqual(await notReady.json(), { status: "not-ready" });
    assert.equal(
      logs.slice(before).some((line) => JSON.parse(line).message === "request.failed"),
      false,
    );
    assert.equal((await fetch(`${base}/health`)).status, 200);
  } finally {
    await app.close();
  }
});

test("known storage 502 retains its contract and logs a safe classification once", () => {
  const { logger, logs } = capturedLogger();
  let status = 0;
  new ProjectExceptionFilter(logger).catch(new ObjectStorageUnavailable(), {
    switchToHttp: () => ({
      getResponse: () => ({
        status(code: number) {
          status = code;
          return { json() {} };
        },
      }),
    }),
  } as never);
  assert.equal(status, 502);
  assert.equal(logs.length, 1);
  assert.equal(JSON.parse(logs[0]!).errorCode, "object_storage_unavailable");
});

import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { bindCorrelationId } from "@editagent/shared";

import { ProjectExceptionFilter } from "./project-exception.filter.js";

test("an unhandled error is problem+json with a trace id and no internals", () => {
  bindCorrelationId("web-request-1");
  let statusCode = 0;
  let contentType = "";
  let body: Record<string, unknown> = {};
  const filter = new ProjectExceptionFilter();
  filter.catch(new Error("secret /tmp/media\n    at hidden (main.ts:1:1)"), {
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
  assert.equal(body["traceId"], "web-request-1");
  assert.equal(body["status"], 500);
  const encoded = JSON.stringify(body);
  assert.equal(encoded.includes("secret"), false);
  assert.equal(encoded.includes("main.ts"), false);
  assert.equal(encoded.includes("stack"), false);
});

test("real unhandled HTTP exception returns safe RFC7807; ordinary statuses are preserved", async () => {
  const { Controller, Get, HttpException, Module } = await import("@nestjs/common");
  const { NestFactory } = await import("@nestjs/core");
  const { bindRequestCorrelation } = await import("./correlation.js");
  const { createServiceLogger } = await import("@editagent/shared");
  const { Writable } = await import("node:stream");
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
  @Controller("test-only-failure")
  class FailureController {
    @Get() fail(): never {
      throw new Error(
        "SECRET_CANARY /srv/private SELECT password postgresql://user:pass@host/database\nError: stack detail",
      );
    }
  }
  @Module({ controllers: [FailureController] })
  class TestModule {}
  const app = await NestFactory.create(TestModule, { logger: false });
  app.use(bindRequestCorrelation(logger));
  app.useGlobalFilters(new ProjectExceptionFilter());
  try {
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    const reply = await fetch(`http://127.0.0.1:${address.port}/test-only-failure`, {
      headers: { "x-request-id": "us115-unhandled-real" },
    });
    assert.equal(reply.status, 500);
    assert.match(reply.headers.get("content-type") ?? "", /application\/problem\+json/);
    const body = (await reply.json()) as Record<string, unknown>;
    assert.equal(body.traceId, "us115-unhandled-real");
    assert.equal(body.type, "about:blank");
    for (const canary of [
      "SECRET_CANARY",
      "/srv/private",
      "SELECT",
      "postgresql",
      "Error:",
      "stack",
    ])
      assert.equal(JSON.stringify(body).includes(canary), false);
    for (const status of [400, 401, 403, 404, 409, 429, 503]) {
      let observed = 0;
      new ProjectExceptionFilter().catch(new HttpException("expected", status), {
        switchToHttp: () => ({
          getResponse: () => ({
            status(code: number) {
              observed = code;
              return { type() {}, json() {} };
            },
          }),
        }),
      } as never);
      assert.equal(observed, status);
    }
    assert.ok(logs.some((line) => JSON.parse(line).correlationId === "us115-unhandled-real"));
  } finally {
    await app.close();
  }
});

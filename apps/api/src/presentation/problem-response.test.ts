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

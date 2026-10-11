import assert from "node:assert/strict";
import { test } from "node:test";
import { HeadBucketCommand, type S3Client } from "@aws-sdk/client-s3";
import { READINESS_DEADLINE_MS } from "@editagent/job-queue";
import { createRenderReadiness, storageReady } from "./readiness.js";

test("startup, dependency loss and recovery are checked afresh; shutdown fails closed", async () => {
  const state = [false, true, true];
  const shutdown = new AbortController();
  const ready = createRenderReadiness(
    state.map((_, i) => async () => state[i]!),
    shutdown.signal,
  );
  assert.equal(await ready(), false);
  state[0] = true;
  assert.equal(await ready(), true);
  for (let i = 0; i < state.length; i++) {
    state[i] = false;
    assert.equal(await ready(), false);
    state[i] = true;
    assert.equal(await ready(), true);
  }
  shutdown.abort();
  assert.equal(await ready(), false);
});

test("only simultaneous probes share work; rejected dependency errors fail safely", async () => {
  let calls = 0;
  let release!: (v: boolean) => void;
  const ready = createRenderReadiness(
    [
      () => {
        calls++;
        return new Promise<boolean>((resolve) => {
          release = resolve;
        });
      },
    ],
    new AbortController().signal,
  );
  const requests = Array.from({ length: 100 }, () => ready());
  assert.equal(calls, 1);
  release(true);
  assert.ok((await Promise.all(requests)).every(Boolean));
  const next = ready();
  assert.equal(calls, 2);
  release(false);
  assert.equal(await next, false);
  assert.equal(
    await createRenderReadiness(
      [
        async () => {
          throw new Error("secret");
        },
      ],
      new AbortController().signal,
    )(),
    false,
  );
});

test("S3 checks the exact bucket; missing bucket, denial and outages fail closed and recover", async () => {
  let available = true;
  const client = {
    send: async (command: HeadBucketCommand, options: { abortSignal: AbortSignal }) => {
      assert.ok(command instanceof HeadBucketCommand);
      assert.equal(command.input.Bucket, "private-render-bucket");
      assert.equal(options.abortSignal.aborted, false);
      if (!available) throw new Error("Credentials and endpoint must not escape");
      return {};
    },
  } as unknown as S3Client;
  assert.equal(await storageReady(client, "private-render-bucket"), true);
  available = false;
  assert.equal(await storageReady(client, "private-render-bucket"), false);
  available = true;
  assert.equal(await storageReady(client, "private-render-bucket"), true);
});

test("a silent S3 connection is aborted within the existing readiness deadline", async () => {
  let signal!: AbortSignal;
  const client = {
    send: (_: unknown, options: { abortSignal: AbortSignal }) => {
      signal = options.abortSignal;
      return new Promise(() => undefined);
    },
  } as unknown as S3Client;
  const start = performance.now();
  assert.equal(await storageReady(client, "private-render-bucket"), false);
  assert.equal(signal.aborted, true);
  assert.ok(performance.now() - start < READINESS_DEADLINE_MS + 500);
});

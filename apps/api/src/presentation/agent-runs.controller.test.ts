import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { userId } from "@editagent/domain";
import type { AgentApi } from "@editagent/agent-core";
import { AgentRunsController } from "./agent-runs.controller.js";
import { bindActor, bindSessionCheck } from "./actor.js";

const id = "018fe277-6ec0-7000-8000-218222000000";
test("AgentRun SSE never trusts a bound identity without live session verification", async () => {
  const req = { headers: {} };
  bindActor(req, userId(id));
  const controller = new AgentRunsController({} as AgentApi);
  await assert.rejects(
    controller.events(id, id, req, {} as Parameters<AgentRunsController["events"]>[3]),
    /Sign in/,
  );
});
test(
  "AgentRun SSE bounds a stalled client and tears down its write",
  { timeout: 7000 },
  async () => {
    const req = { headers: {} };
    bindActor(req, userId(id));
    bindSessionCheck(req, async () => true);
    const reply = Object.assign(new EventEmitter(), {
      setHeader() {},
      flushHeaders() {},
      write() {
        return false;
      },
      end() {},
      destroy() {
        destroyed++;
        reply.emit("close");
      },
    });
    let destroyed = 0;
    const controller = new AgentRunsController({
      events: async () => [],
      get: async () => {
        throw new Error("no event");
      },
    } as unknown as AgentApi);
    const before = Date.now();
    await controller.events(id, id, req, reply);
    assert.equal(destroyed, 1);
    assert.ok(Date.now() - before < 6500);
  },
);
test("invalid audit limits and cancellation payloads fail before the repository", () => {
  const controller = new AgentRunsController({} as AgentApi),
    req = {};
  bindActor(req, userId(id));
  for (const limit of ["0", "101", "-1", "2.5", "NaN", "10000000"])
    assert.throws(() => controller.audit(id, id, req, undefined, limit));
  assert.throws(() => controller.cancel(id, id, req, { tool: "arbitrary" }));
});

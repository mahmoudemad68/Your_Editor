import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { Project, projectId, userId, instant, type JobEvent } from "@editagent/domain";
import { InMemoryProjectRepository } from "../application/in-memory-project-repository.js";
import { ProjectJobEvents } from "../application/job-events.js";
import { bindActor } from "./actor.js";
import { JobEventsController } from "./job-events.controller.js";

const project = projectId("018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4f");
const actor = userId("018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4a");
const id = "018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4b";
class Reply extends EventEmitter {
  readonly chunks: string[] = [];
  writable = false;
  ended = false;
  destroyed = false;
  destroyCalls = 0;
  callbacks: Array<(error?: Error | null) => void> = [];
  setHeader(): void {}
  flushHeaders(): void {}
  write(chunk: string, callback: (error?: Error | null) => void): boolean {
    this.chunks.push(chunk);
    if (this.writable) callback();
    else this.callbacks.push(callback);
    return this.writable;
  }
  destroy(): void {
    this.destroyed = true;
    this.destroyCalls++;
  }
  end(): void {
    this.ended = true;
  }
}
async function setup(writable = false) {
  const projects = new InMemoryProjectRepository();
  await projects.save(Project.create(project, "test", actor, instant(1n)), null);
  let receive: (event: JobEvent) => void = () => undefined;
  let count = 0;
  const events = new ProjectJobEvents(projects, {
    async subscribe(_id, callback) {
      receive = callback;
      count++;
      return {
        async close() {
          count--;
        },
      };
    },
    async close() {},
  });
  const controller = new JobEventsController(events);
  const request = {};
  bindActor(request, actor);
  const response = new Reply();
  response.writable = writable;
  await controller.stream(project, request, response);
  return { events, response, send: (event: JobEvent) => receive(event), count: () => count };
}
function base(sequence: number) {
  return {
    schemaVersion: 1 as const,
    eventId: `${id}:${sequence}`,
    sequence,
    jobId: id,
    projectId: project,
    jobType: "sample.progress",
    attempt: 1,
    occurredAt: new Date().toISOString(),
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("slow SSE preserves latest progress and terminal on drain, with bounded listeners", async () => {
  const { events, response, send, count } = await setup();
  try {
    for (let i = 0; i <= 100; i++)
      send({ ...base(i + 1), kind: "progress", percentage: i, stage: "proxy" });
    send({ ...base(102), kind: "state", status: "Completed" });
    assert.equal(response.chunks.length, 1, "no writes after backpressure");
    response.writable = true;
    response.emit("drain");
    await tick();
    await tick();
    const data = response.chunks.join("");
    assert.ok(data.includes('"percentage":100'));
    assert.ok(data.includes('"status":"Completed"'));
    assert.equal(response.chunks.length, 3);
    response.emit("close");
    await tick();
    assert.equal(count(), 0);
    assert.equal(response.listenerCount("drain"), 0);
    assert.equal(response.listenerCount("close"), 0);
  } finally {
    await events.onModuleDestroy();
  }
});
test("slow SSE disconnects at state buffer limit and application shutdown frees all clients", async () => {
  const { events, response, send, count } = await setup();
  for (let i = 1; i <= 65; i++) send({ ...base(i), kind: "state", status: "Running" });
  await tick();
  assert.equal(response.destroyed, true);
  assert.equal(response.ended, false);
  assert.equal(count(), 0);
  assert.equal(response.listenerCount("drain"), 0);
  await events.onModuleDestroy();
  const another = await setup();
  await another.events.onModuleDestroy();
  await tick();
  assert.equal(another.response.ended, true);
  assert.equal(another.count(), 0);
});

test("blocked deadline destroys once; queued events cannot extend it, and cleanup stops timers/buffers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let elapsed = 0;
  t.mock.method(performance, "now", () => elapsed);
  const { events, response, send, count } = await setup();
  for (let sequence = 1; sequence <= 100; sequence++)
    send({ ...base(sequence), kind: "progress", percentage: 50, stage: "proxy" });
  elapsed = 4900;
  t.mock.timers.tick(4900);
  assert.equal(response.destroyed, false);
  send({ ...base(101), kind: "progress", percentage: 100, stage: "finalizing" });
  elapsed = 5000;
  t.mock.timers.tick(100);
  await tick();
  assert.equal(response.destroyed, true);
  assert.equal(response.destroyCalls, 1);
  assert.equal(response.ended, false);
  assert.equal(count(), 0);
  assert.equal(response.listenerCount("drain"), 0);
  assert.equal(response.listenerCount("close"), 0);
  response.writable = true;
  response.emit("drain");
  response.emit("close");
  send({ ...base(102), kind: "state", status: "Completed" });
  elapsed = 25000;
  t.mock.timers.tick(20000);
  await events.onModuleDestroy();
  assert.equal(response.chunks.length, 1, "pending/heartbeat writes cannot survive cleanup");
  assert.equal(response.destroyCalls, 1);
});

test("backpressure after an expired confirmed-progress deadline aborts immediately", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let elapsed = 0;
  t.mock.method(performance, "now", () => elapsed);
  const { events, response, send } = await setup(true);
  elapsed = 6000;
  response.writable = false;
  send({ ...base(1), kind: "progress", percentage: 50, stage: "proxy" });
  await tick();
  assert.equal(response.destroyed, true, "no fresh five-second grace after stale forward progress");
  assert.equal(response.destroyCalls, 1);
  await events.onModuleDestroy();
});

test("only a completed write or drain confirms writable progress while blocked", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let elapsed = 0;
  t.mock.method(performance, "now", () => elapsed);
  const { events, response, send } = await setup();
  elapsed = 2000;
  t.mock.timers.tick(2000);
  response.callbacks.shift()!();
  elapsed = 3000;
  t.mock.timers.tick(1000);
  send({ ...base(1), kind: "progress", percentage: 50, stage: "proxy" });
  elapsed = 5000;
  t.mock.timers.tick(2000);
  assert.equal(response.destroyed, false, "completed write establishes genuine new progress");
  elapsed = 6999;
  t.mock.timers.tick(1999);
  assert.equal(response.destroyed, false);
  elapsed = 7000;
  t.mock.timers.tick(1);
  assert.equal(
    response.destroyed,
    true,
    "queued report did not move the deadline to eight seconds",
  );
  assert.equal(response.destroyCalls, 1);
  await events.onModuleDestroy();
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { Timeline, parseCommand, replay } from "@editagent/domain";
import { ToolRegistry, type ITool } from "./registry.js";
import { ToolExecutor } from "./executor.js";
import { manifest, tool, ids, call, authority, MemoryAudit } from "./test-support.js";
const setup = (
  impl: ITool = tool((i) => ({ output: i, costMicros: 1 })),
  change: Parameters<typeof manifest>[0] = {},
  audit = new MemoryAudit(),
) => {
  const r = new ToolRegistry();
  r.register(manifest(change), { mode: "in-process", tool: impl });
  return { executor: new ToolExecutor(r, authority, audit), audit };
};
test("valid execution and authorized durable-port query", async () => {
  const { executor, audit } = setup();
  const r = await executor.execute(call);
  assert.equal(r.record.outcome, "succeeded");
  assert.equal(r.record.costMicros, 1);
  assert.equal((await executor.record(ids.owner, r.record.id))?.inputHash, r.record.inputHash);
  await assert.rejects(executor.record(ids.viewer, r.record.id), /denied/);
  assert.equal((await executor.records(ids.owner, ids.project)).length, 1);
  assert.ok(!JSON.stringify([...audit.rows.values()]).includes('"hello"'));
});
test("denial, malformed input, unknown tool and invalid identity all audited with zero side effects", async () => {
  let count = 0;
  const { executor, audit } = setup(
    tool((i) => {
      count++;
      return { output: i, costMicros: 1 };
    }),
  );
  for (const c of [
    { ...call, callerId: ids.viewer },
    { ...call, projectId: ids.tool },
    { ...call, input: { text: 1 } },
    { ...call, name: "test.unknown" },
    { ...call, callerId: "INVALID" },
    { ...call, resource: { kind: "project" as const, id: ids.tool } },
  ])
    await assert.rejects(executor.execute(c));
  assert.equal(count, 0);
  assert.equal(audit.rows.size, 6);
  assert.ok([...audit.rows.values()].every((r) => r.outcome === "rejected" && r.costMicros === 0));
});
test("invalid output and excessive actual cost fail without result exposure; audit sanitized", async () => {
  for (const result of [
    { output: { text: 42 }, costMicros: 1 },
    { output: { text: "valid" }, costMicros: 11 },
  ]) {
    const { executor, audit } = setup(tool(() => result));
    await assert.rejects(executor.execute(call));
    assert.equal([...audit.rows.values()][0]?.outcome, "failed");
  }
});
test("timeout and abort wait for cleanup, no late work; terminal records immutable", async () => {
  for (const cancel of [false, true]) {
    let sideEffect = 0,
      cleaned = false;
    const impl: ITool = {
      start() {
        let timer: ReturnType<typeof setTimeout>;
        const result = new Promise<{ output: unknown; costMicros: number }>((resolve) => {
          timer = setTimeout(() => {
            sideEffect++;
            resolve({ output: { text: "late" }, costMicros: 1 });
          }, 200);
        });
        return {
          result,
          cancel: async () => {
            clearTimeout(timer);
            cleaned = true;
          },
        };
      },
    };
    const { executor, audit } = setup(impl, { timeoutMs: 20 });
    const controller = new AbortController();
    const p = executor.execute(call, controller.signal);
    if (cancel) setTimeout(() => controller.abort(), 5);
    await assert.rejects(p, cancel ? /cancelled/ : /timed_out/);
    assert.ok(cleaned);
    assert.equal(sideEffect, 0);
    const r = [...audit.rows.values()][0]!;
    assert.equal(r.outcome, cancel ? "cancelled" : "timed_out");
    assert.equal((await audit.finish(r.id, "succeeded", null, 0)).outcome, r.outcome);
  }
});
test("concurrent bounded budget reserves before any implementation work", async () => {
  let count = 0;
  const audit = new MemoryAudit(10);
  const { executor } = setup(
    tool((i) => {
      count++;
      return { output: i, costMicros: 10 };
    }),
    {},
    audit,
  );
  const results = await Promise.allSettled([executor.execute(call), executor.execute(call)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(count, 1);
});
test("mutation returns validated replayable commands; invalid subject/command leaves original untouched", async () => {
  const snapshot = {
    id: ids.timeline,
    projectId: ids.project,
    createdAt: "0",
    composition: {
      width: 320,
      height: 180,
      frameRate: { numerator: "30", denominator: "1" },
      durationUs: "2000000",
    },
    sources: [],
    tracks: [
      { id: ids.track, timelineId: ids.timeline, kind: "caption", clips: [], transitions: [] },
    ],
  };
  const timeline = Timeline.restore(snapshot);
  const command = parseCommand({
    schemaVersion: 1,
    id: ids.command,
    timelineId: ids.timeline,
    type: "AddCaption",
    payload: {
      captionId: ids.caption,
      trackId: ids.track,
      startUs: "0",
      endUs: "1000000",
      text: "مرحبا 😀",
    },
  });
  const stringSchema = { type: "string", maxLength: 128 };
  const payload = {
    type: "object",
    additionalProperties: false,
    required: ["captionId", "trackId", "startUs", "endUs", "text"],
    properties: Object.fromEntries(
      ["captionId", "trackId", "startUs", "endUs", "text"].map((k) => [k, stringSchema]),
    ),
  };
  const commandSchema = {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "id", "timelineId", "type", "payload"],
    properties: {
      schemaVersion: { type: "integer", const: 1 },
      id: stringSchema,
      timelineId: stringSchema,
      type: { ...stringSchema, const: "AddCaption" },
      payload,
    },
  };
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["commands"],
    properties: { commands: { type: "array", maxItems: 100, items: commandSchema } },
  };
  const r = new ToolRegistry();
  r.register(
    manifest({
      mutating: true,
      permissions: ["project.read", "timeline.propose"],
      outputSchema: schema,
    }),
    { mode: "in-process", tool: tool(() => ({ output: { commands: [command] }, costMicros: 1 })) },
  );
  const audit = new MemoryAudit();
  const executor = new ToolExecutor(r, { ...authority, timeline: async () => timeline }, audit);
  const c = { ...call, resource: { kind: "timeline" as const, id: ids.timeline } };
  const result = await executor.execute(c);
  assert.equal(result.commands.length, 1);
  assert.equal(
    replay(timeline, { schemaVersion: 1, timelineId: ids.timeline, commands: result.commands })
      .tracks[0]?.clips.length,
    1,
  );
  assert.deepEqual(timeline.toSnapshot(), snapshot);
  await assert.rejects(executor.execute(call));
});

test("malformed roots/accessors and call grants fail closed and receive audit rows", async () => {
  const { executor, audit } = setup();
  for (const c of [
    null,
    { ...call, grants: ["shell"] },
    {
      ...call,
      input: {
        get text() {
          throw new Error("must not run getter");
        },
      },
    },
  ])
    await assert.rejects(executor.execute(c as never));
  assert.equal(audit.rows.size, 3);
  assert.ok([...audit.rows.values()].every((r) => r.outcome === "rejected"));
});
test("pre-cancelled input, instance capacity, cancellation at result exposure and observational events", async () => {
  let cleaned = 0;
  const r = new ToolRegistry();
  let release: (value: { output: unknown; costMicros: number }) => void = () => undefined;
  const impl: ITool = {
    start() {
      return {
        result: new Promise((resolve) => {
          release = resolve;
        }),
        cancel: async () => {
          cleaned++;
        },
      };
    },
  };
  r.register(manifest(), { mode: "in-process", tool: impl });
  const audit = new MemoryAudit();
  const observed: string[] = [];
  const executor = new ToolExecutor(r, authority, audit, undefined, 1, (record) => {
    observed.push(record.outcome);
    return Promise.reject(new Error("event sink down"));
  });
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(executor.execute(call, pre.signal), /cancelled/);
  const c = new AbortController();
  const first = executor.execute(call, c.signal);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(executor.execute(call), /capacity_exceeded/);
  release({ output: call.input, costMicros: 1 });
  c.abort();
  await assert.rejects(first, /cancelled/);
  assert.ok(cleaned);
  assert.deepEqual(observed, ["cancelled", "rejected", "cancelled"]);
  assert.throws(() => new ToolExecutor(r, authority, audit, undefined, 0), /concurrency/);
});

test("implementation error codes/messages cannot leak credentials into audit", async () => {
  const { executor, audit } = setup(
    tool(() => {
      throw new Error("private-password-do-not-store");
    }),
  );
  await assert.rejects(executor.execute(call));
  assert.ok(!JSON.stringify([...audit.rows.values()]).includes("private-password"));
});

test("executor preserves safe input field/rule diagnostics", async () => {
  const { executor } = setup();
  await assert.rejects(executor.execute({ ...call, input: { text: 1 } }), /\/text.*type/);
});

test("timeout also bounds a stalled authority port, with no implementation side effect", async () => {
  const r = new ToolRegistry();
  let effects = 0;
  r.register(manifest({ timeoutMs: 20 }), {
    mode: "in-process",
    tool: tool((i) => {
      effects++;
      return { output: i, costMicros: 1 };
    }),
  });
  const audit = new MemoryAudit();
  const executor = new ToolExecutor(
    r,
    { ...authority, authorize: () => new Promise(() => undefined) },
    audit,
  );
  await assert.rejects(executor.execute(call), /timed_out/);
  assert.equal(effects, 0);
  assert.equal([...audit.rows.values()][0]!.outcome, "timed_out");
});

test("UUID aliases, case and trailing controls are rejected before side effects", async () => {
  let effects = 0;
  const { executor, audit } = setup(
    tool((i) => {
      effects++;
      return { output: i, costMicros: 1 };
    }),
  );
  for (const invalid of [
    ids.owner.toUpperCase(),
    ids.owner + "\n",
    ids.owner + " ",
    "../" + ids.owner,
  ])
    await assert.rejects(executor.execute({ ...call, callerId: invalid }));
  assert.equal(effects, 0);
  assert.equal(audit.rows.size, 4);
});

test("QA49 F3 cleanup rejection never leaks raw errors or prevents terminal audit; primary failure wins", async () => {
  const secret = "postgres://credential@internal/private/token";
  for (const failure of [
    "execution_failed",
    "invalid_output",
    "cleanup_unconfirmed",
    "timed_out",
    "cancelled",
  ]) {
    let cleanupAttempts = 0;
    const { executor, audit } = setup(
      {
        start() {
          return {
            result:
              failure === "execution_failed"
                ? Promise.reject(new Error(secret))
                : failure === "timed_out" || failure === "cancelled"
                  ? new Promise(() => undefined)
                  : Promise.resolve({
                      output: failure === "invalid_output" ? { text: 1 } : call.input,
                      costMicros: 1,
                    }),
            cancel: async () => {
              cleanupAttempts++;
              throw new Error(secret);
            },
          };
        },
      },
      { timeoutMs: 20 },
    );
    const abort = new AbortController();
    if (failure === "cancelled") setTimeout(() => abort.abort(), 5);
    await assert.rejects(executor.execute(call, abort.signal), (error: Error) => {
      assert.ok(error.message.includes(failure));
      assert.ok(!error.message.includes(secret));
      assert.ok(!error.stack?.includes(secret));
      assert.ok(!error.stack?.includes("/workspace/"));
      assert.ok(!error.stack?.includes(" at "));
      return true;
    });
    const row = [...audit.rows.values()][0]!;
    assert.notEqual(row.outcome, "running");
    assert.equal(row.code, failure);
    assert.equal(row.cleanupStatus, "failed");
    assert.equal(row.cleanupCode, "cleanup_unconfirmed");
    assert.ok(row.durationMs !== null);
    assert.equal(cleanupAttempts, 2);
    assert.equal((await executor.record(ids.owner, row.id))?.outcome, row.outcome);
    assert.ok(!JSON.stringify(row).includes(secret));
  }
});

test("QA49 F3 independent owned escalation stops actual timer after graceful cleanup rejection", async () => {
  for (const cancellation of [false, true]) {
    let alive = false,
      effects = 0,
      escalations = 0;
    const { executor, audit } = setup(
      {
        start() {
          alive = true;
          const timer = setTimeout(() => effects++, 200);
          return {
            result: new Promise(() => undefined),
            cancel: async () => {
              throw new Error("SECRET");
            },
            forceStop: async () => {
              clearTimeout(timer);
              alive = false;
              escalations++;
            },
          };
        },
      },
      { timeoutMs: 20 },
    );
    const controller = new AbortController();
    if (cancellation) setTimeout(() => controller.abort(), 5);
    await assert.rejects(
      executor.execute(call, controller.signal),
      cancellation ? /cancelled/ : /timed_out/,
    );
    assert.equal(alive, false);
    assert.equal(effects, 0);
    assert.equal(escalations, 1);
    assert.equal([...audit.rows.values()][0]?.cleanupStatus, "succeeded");
  }
});

test("QA49 F4 historical record ownership cannot bypass current authority or list scope", async () => {
  const registry = new ToolRegistry();
  registry.register(manifest(), {
    mode: "in-process",
    tool: tool((i) => ({ output: i, costMicros: 1 })),
  });
  let member = true;
  const currentAuthority = {
    ...authority,
    authorize: async (...args: Parameters<typeof authority.authorize>) => {
      if (!member) throw new Error("denied");
      await authority.authorize(...args);
    },
  };
  const executor = new ToolExecutor(registry, currentAuthority, new MemoryAudit());
  const result = await executor.execute(call);
  member = false;
  await assert.rejects(executor.record(ids.owner, result.record.id), /denied/);
  for (const limit of [1, 50, 100])
    await assert.rejects(executor.records(ids.owner, ids.project, limit), /denied/);
  member = true;
  assert.equal((await executor.record(ids.owner, result.record.id))?.outcome, "succeeded");
});

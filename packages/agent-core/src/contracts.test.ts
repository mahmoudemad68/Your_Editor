import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentRunV1Schema, AgentStepEventV1Schema, AgentStepV1Schema } from "@editagent/schemas";
import { AgentError, assertRun, checkedUuid, type AgentRunView } from "./contracts.js";

const id = "018fe277-6ec0-7000-8000-218222000000";
const run: AgentRunView = {
  schemaVersion: "1.0.0",
  id,
  projectId: id,
  state: "Pending",
  revision: 1,
  sequence: 1,
  checkpoint: 0,
  generation: 0,
  stopReason: null,
  createdAtMs: 1,
  updatedAtMs: 1,
  deadlineAtMs: 120001,
  source: null,
  runtime: { driver: "infrastructure-v1", planner: "not_configured" },
};
test("versioned AgentRun schema bounds counters and forbids private payloads", () => {
  assert.deepEqual(assertRun(run), run);
  for (const patch of [
    { schemaVersion: "2.0.0" },
    { state: "invented" },
    { checkpoint: 65 },
    { revision: -1 },
    { sequence: 257 },
    { createdAtMs: 1.5 },
    { prompt: "private" },
    { runtime: { driver: "llm", planner: "configured" } },
  ])
    assert.equal(AgentRunV1Schema.safeParse({ ...run, ...patch }).success, false);
  assert.throws(() => assertRun({ ...run, checkpoint: 65 }), AgentError);
  assert.throws(() => checkedUuid("../../../private"), AgentError);
});
test("events and steps carry explicit unknown usage and allowlisted summaries only", () => {
  const tool = {
    name: "editing.trim-video",
    version: "1.0.0",
    inputSha256: "a".repeat(64),
    outputSha256: null,
    receiptId: id,
    outcome: "unconfirmed",
    durationMs: null,
    costMicros: null,
  };
  const event = {
    schemaVersion: "1.0.0",
    id,
    runId: id,
    sequence: 1,
    revision: 1,
    state: "Executing",
    kind: "tool_result",
    summary: "TOOL_FINISHED",
    atMs: 1,
    correlationId: id,
    requestCorrelationSha256: "a".repeat(64),
    stopReason: null,
    tool,
    tokens: null,
    tokenMeasurement: "not_applicable",
    decision: "no_llm",
  };
  assert.equal(AgentStepEventV1Schema.safeParse(event).success, true);
  for (const patch of [
    { summary: "raw private exception" },
    { tokens: 0 },
    { secret: "forbidden" },
    { tool: { ...tool, input: { private: "data" } } },
    { tool: { ...tool, name: "arbitrary.shell" } },
  ])
    assert.equal(AgentStepEventV1Schema.safeParse({ ...event, ...patch }).success, false);
  assert.equal(
    AgentStepV1Schema.safeParse({
      schemaVersion: "1.0.0",
      id,
      runId: id,
      ordinal: 0,
      receiptId: id,
      name: tool.name,
      version: tool.version,
      inputSha256: tool.inputSha256,
    }).success,
    true,
  );
});

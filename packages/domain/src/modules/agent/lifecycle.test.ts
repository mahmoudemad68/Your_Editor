import assert from "node:assert/strict";
import { test } from "vitest";
import fc from "fast-check";
import { AGENT_STATES, assertAgentTransition, agentTerminal } from "./lifecycle.js";

test("AgentRun transitions reject every illegal edge and terminal resurrection", () => {
  const normal = new Set([
    "Pending:Observing",
    "Observing:Planning",
    "Planning:Executing",
    "Executing:Rendering",
    "Executing:Evaluating",
    "Rendering:Evaluating",
    "Evaluating:Completed",
  ]);
  for (const from of AGENT_STATES)
    for (const to of AGENT_STATES) {
      const allowed =
        !agentTerminal(from) &&
        (normal.has(`${from}:${to}`) || to === "Cancelled" || to === "Failed");
      const invoke = () =>
        assertAgentTransition(
          from,
          to,
          to === "Cancelled" ? "CANCELLED" : to === "Failed" ? "INTERNAL" : null,
        );
      if (allowed) assert.doesNotThrow(invoke);
      else assert.throws(invoke);
    }
});
test("AgentRun stop reasons cannot masquerade as a successful checkpoint", () => {
  fc.assert(
    fc.property(fc.constantFrom(...AGENT_STATES), (state) => {
      assert.throws(() => assertAgentTransition(state, "Completed", "INTERNAL"));
      assert.throws(() => assertAgentTransition(state, "Cancelled", null));
      assert.throws(() => assertAgentTransition(state, "Failed", "CANCELLED"));
    }),
  );
  assert.doesNotThrow(() => assertAgentTransition("Planning", "Failed", "PLANNER_NOT_CONFIGURED"));
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { inlinePromptFindings, scanPromptSources } from "../../tools/prompts/lint.mjs";
test("targeted prompt lint rejects ad-hoc production instructions but ignores normal strings", () => {
  const long = "safe ordinary words ".repeat(15);
  for (const source of [
    `const systemPrompt = ${JSON.stringify(long)}`,
    `const prompt = \`${long}\``,
    `const messages=[{role:'system',content:${JSON.stringify(long)}}]`,
  ])
    assert.equal(inlinePromptFindings(source).length, 1);
  for (const source of [
    `const title=${JSON.stringify(long)}`,
    `const helpText=${JSON.stringify(long)}`,
    `const x={role:'user',content:${JSON.stringify(long)}}`,
    `const systemPrompt=registry.load('agent-context','1.0.0').render(vars)`,
  ])
    assert.deepEqual(inlinePromptFindings(source), []);
  assert.deepEqual(scanPromptSources(process.cwd()), []);
});

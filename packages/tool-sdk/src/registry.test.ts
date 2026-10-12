import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolRegistry } from "./registry.js";
import { compileSchema, jsonValue, contentHash } from "./validation.js";
import { manifest, tool, ids, objectSchema } from "./test-support.js";
const binding = { mode: "in-process" as const, tool: tool((i) => ({ output: i, costMicros: 1 })) };
test("JSON byte budget rejects repeated large values before whole-document serialization", () => {
  const repeated = Array(20_000).fill("x".repeat(65_536));
  assert.throws(() => jsonValue(repeated), /byte limit/);
  assert.throws(() => jsonValue({ text: "\\".repeat(600_000) }), /byte limit/);
  assert.deepEqual(jsonValue({ text: "مرحبا 👩‍💻", values: [true, false, null, 1] }), {
    text: "مرحبا 👩‍💻",
    values: [true, false, null, 1],
  });
});
test("exported function names fit the portable 64-character bound without truncation", () => {
  const name = `${"a".repeat(23)}.${"b".repeat(23)}`;
  const r = new ToolRegistry();
  r.register(manifest({ name, version: "9999.9999.9999" }), binding);
  const exported = r.exportFunctions()[0] as { function: { name: string } };
  assert.equal(exported.function.name.length, 64);
  assert.match(exported.function.name, /^[A-Za-z0-9_-]+$/);
  assert.throws(() =>
    new ToolRegistry().register(
      manifest({ name: `${"a".repeat(24)}.${"b".repeat(24)}`, version: "9999.9999.9999" }),
      binding,
    ),
  );
});
test("new tool registration, exact versions, capabilities and stable faithful function export", () => {
  const r = new ToolRegistry();
  r.register(manifest(), binding);
  r.register(manifest({ version: "1.1.0" }), binding);
  r.register(
    manifest({ id: ids.command, name: "test.another", capabilities: ["vision"] }),
    binding,
  );
  assert.equal(r.discover().length, 3);
  assert.equal(r.discover("audio").length, 2);
  assert.equal(r.lookup("test.echo", "1.0.0").manifest.version, "1.0.0");
  assert.throws(() => r.lookup("test.echo", "latest"));
  const exported = JSON.stringify(r.exportFunctions());
  assert.equal(exported, JSON.stringify(r.exportFunctions()));
  assert.ok(exported.includes('"maxLength":128'));
  assert.deepEqual(
    (r.exportFunctions()[1] as { function: { parameters: unknown } }).function.parameters,
    objectSchema,
  );
  assert.throws(() => r.register(manifest(), binding), /duplicate/);
  assert.throws(() => r.register(manifest({ id: ids.command }), binding), /duplicate/);
});
test("caller manifest mutation cannot widen stored schema or permissions", () => {
  const m = structuredClone(manifest());
  const r = new ToolRegistry();
  r.register(m, binding);
  (m.inputSchema.properties as Record<string, unknown>).evil = { type: "string" };
  assert.equal(contentHash(r.lookup(m.name, m.version).manifest), contentHash(manifest()));
  assert.ok(Object.isFrozen(r.lookup(m.name, m.version).manifest));
});
for (const permission of ["shell", "filesystem", "network", "http.fetch", "asset.write"]) {
  test(`forbidden capability ${permission}`, () =>
    assert.throws(() =>
      new ToolRegistry().register(manifest({ permissions: [permission] as never }), binding),
    ));
}
test("explicit input/output field and rule errors; no coercion, defaults or Unicode corruption", () => {
  const r = new ToolRegistry();
  r.register(manifest(), binding);
  const t = r.lookup("test.echo", "1.0.0");
  for (const phase of ["input", "output"] as const) {
    assert.throws(() => r.validate(t, phase, { text: 42 }), /\/text.*type/);
    assert.throws(() => r.validate(t, phase, { text: "x", extra: 1 }), /additionalProperties/);
    assert.throws(() => r.validate(t, phase, { text: "x".repeat(129) }), /maxLength/);
    assert.throws(() => r.validate(t, phase, { text: "\ud800" }), /Unicode/);
    assert.deepEqual(r.validate(t, phase, { text: "مرحبا 👩‍💻" }), { text: "مرحبا 👩‍💻" });
  }
  assert.throws(() => jsonValue(JSON.parse('{"__proto__":{}}')));
  assert.throws(() => jsonValue({ constructor: "x" }));
  assert.throws(
    () =>
      jsonValue({
        get text() {
          throw new Error("must not run");
        },
      }),
    /Executable/,
  );
  for (const value of [NaN, Infinity, () => 1, undefined, new Date()])
    assert.throws(() => jsonValue(value));
});
test("relational validation is both enforced and exported, missing rule fields fail closed", () => {
  const r = new ToolRegistry();
  const s = {
    type: "object",
    additionalProperties: false,
    required: ["start", "end"],
    properties: { start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 0 } },
  };
  r.register(
    manifest({
      inputSchema: s,
      validationRules: [{ phase: "input", kind: "ordered", start: "start", end: "end" }],
    }),
    binding,
  );
  assert.throws(
    () => r.validate(r.lookup("test.echo", "1.0.0"), "input", { start: 2, end: 1 }),
    /ordered/,
  );
  assert.ok(JSON.stringify(r.exportFunctions()).includes('"kind":"ordered"'));
  assert.throws(() =>
    new ToolRegistry().register(
      manifest({
        inputSchema: s,
        validationRules: [{ phase: "input", kind: "ordered", start: "missing", end: "end" }],
      }),
      binding,
    ),
  );
});
for (const schema of [
  { ...objectSchema, $ref: "https://evil.invalid" },
  { type: "string", maxLength: "process.exit()" },
  { type: "array", maxItems: 1.5, items: { type: "boolean" } },
  { type: "number", maximum: Infinity },
  { type: "string", maxLength: 30, pattern: "(a+)+$" },
  { type: "object", properties: {}, additionalProperties: true },
])
  test(`hostile schema rejected ${JSON.stringify(schema)}`, () =>
    assert.throws(() => compileSchema(schema)));

test("deterministic hostile JSON/property corpus preserves Unicode and rejects malformed values", () => {
  const r = new ToolRegistry();
  r.register(manifest(), binding);
  const t = r.lookup("test.echo", "1.0.0");
  let seed = 219221;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const valid = ["مرحبا", "hello world", "👩‍💻", "'\";:$()\\\\", "  text  "];
  for (let i = 0; i < 200; i++) {
    const text = valid[next() % valid.length]!;
    const original = { text };
    assert.deepEqual(r.validate(t, "input", original), original);
    assert.deepEqual(r.validate(t, "output", original), original);
    const bad = [
      { text: next() },
      { text: null },
      { text, unknown: 1 },
      { text: "\udfff" },
      { text: "a".repeat(129) },
    ][next() % 5]!;
    for (const phase of ["input", "output"] as const)
      assert.throws(() => r.validate(t, phase, bad));
  }
  const array: unknown[] = [];
  Object.defineProperty(array, "0", {
    get() {
      throw new Error("getter must never execute");
    },
    enumerable: true,
  });
  assert.throws(() => jsonValue(array), /Executable/);
});

test("manifest versions and function input contracts reject ambiguity", () => {
  for (const version of ["01.0.0", "1.02.0", "1.0.03", "1.0.0\n", "latest"])
    assert.throws(() => new ToolRegistry().register(manifest({ version }), binding));
  assert.throws(() =>
    new ToolRegistry().register(
      manifest({ inputSchema: { type: "string", maxLength: 16 } }),
      binding,
    ),
  );
  assert.throws(() => new ToolRegistry().register(manifest({ id: ids.tool + "\n" }), binding));
});

test("QA49 F1 missing/extra properties identify escaped full JSON Pointer in nested arrays", () => {
  const nested = {
    type: "object",
    additionalProperties: false,
    required: ["a/b~c"],
    properties: {
      "a/b~c": {
        type: "array",
        maxItems: 2,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["x/y~z"],
          properties: { "x/y~z": { type: "string", maxLength: 32 } },
        },
      },
    },
  };
  const r = new ToolRegistry();
  r.register(manifest({ inputSchema: nested, outputSchema: nested }), binding);
  const t = r.lookup("test.echo", "1.0.0");
  for (const phase of ["input", "output"] as const) {
    for (const [value, field, rule] of [
      [{}, "/a~1b~0c", "required"],
      [{ "a/b~c": [{}] }, "/a~1b~0c/0/x~1y~0z", "required"],
      [
        { "a/b~c": [{ "x/y~z": "ok", "extra/~": "SECRET_VALUE" }] },
        "/a~1b~0c/0/extra~1~0",
        "additionalProperties",
      ],
      [{ "a/b~c": [{ "x/y~z": 12345 }] }, "/a~1b~0c/0/x~1y~0z", "type"],
    ] as const) {
      assert.throws(
        () => r.validate(t, phase, value),
        (error: Error) => {
          assert.ok(error.message.includes(field));
          assert.ok(error.message.includes(rule));
          assert.ok(!error.message.includes("SECRET_VALUE"));
          assert.ok(!error.message.includes("12345"));
          return true;
        },
      );
    }
  }
  assert.deepEqual(
    (r.exportFunctions()[0] as { function: { parameters: unknown } }).function.parameters,
    nested,
  );
});

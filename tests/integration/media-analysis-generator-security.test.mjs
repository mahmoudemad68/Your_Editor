import assert from "node:assert/strict";
import { test } from "node:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  sourceFiles,
  targets,
  generate,
  run,
} from "../../tools/schema/generate-media-analysis.mjs";
import { keywordMatrix } from "../../tools/schema/media-analysis-preflight.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const commonPath = "packages/schemas/src/analysis-common.schema.json";
const rootPath = "packages/schemas/src/media-analysis.schema.json";
const compiler = resolve(root, "tools/schema/generate-media-analysis.mjs");
function workspace(t) {
  const dir = mkdtempSync(resolve(tmpdir(), "editagent-codegen-security-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of [...sourceFiles, ...targets]) {
    mkdirSync(dirname(resolve(dir, file)), { recursive: true });
    copyFileSync(resolve(root, file), resolve(dir, file));
  }
  return dir;
}
function modify(dir, file, change) {
  const schema = JSON.parse(readFileSync(resolve(root, file), "utf8"));
  change(schema);
  writeFileSync(resolve(dir, file), JSON.stringify(schema));
}
function rejected(dir, label) {
  const before = targets.map((p) => readFileSync(resolve(dir, p)));
  const result = spawnSync(process.execPath, [compiler, "--root", dir], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, label);
  assert.equal(result.status, 1, `${label}: ${result.stderr}`);
  assert.match(result.stderr, /Schema preflight:/, label);
  for (const [i, file] of targets.entries())
    assert.deepEqual(readFileSync(resolve(dir, file)), before[i], label);
  assert.equal(existsSync(resolve(dir, "payload-marker")), false, label);
  assert.deepEqual(
    readdirSync(dir).sort(),
    ["packages", "workers"],
    "No temporary executable or marker",
  );
}
function probe(t, node, label) {
  const dir = workspace(t);
  modify(dir, commonPath, (s) => {
    s.$defs.SecurityProbe = node;
  });
  rejected(dir, label);
}

test("QA40-F1 numeric executable payloads fail the actual CLI before writing either language", (t) => {
  const dir = workspace(t);
  const marker = resolve(dir, "payload-marker");
  const javascript = `1); require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); //`;
  const python = `1), __import__('pathlib').Path(${JSON.stringify(marker)}).write_text('executed'), Field(le=1`;
  const cases = [
    ["maximum", javascript, { type: "number" }],
    ["maximum", python, { type: "number" }],
    ["maxItems", python, { type: "array", items: { type: "string" } }],
    ["maxLength", javascript, { type: "string" }],
  ];
  for (const [keyword, value, base] of cases) {
    modify(dir, commonPath, (s) => {
      s.$defs.SecurityProbe = { ...base, [keyword]: value };
    });
    rejected(dir, keyword);
  }
});

test("QA40-F1 all numeric/count keywords reject coercion, unsafe bounds and impossible ranges", (t) => {
  const bounds = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"];
  const counts = ["minLength", "maxLength", "minItems", "maxItems", "minProperties"];
  for (const keyword of [...bounds, ...counts]) {
    const base = bounds.includes(keyword)
      ? { type: "number" }
      : keyword.includes("Length")
        ? { type: "string" }
        : keyword.includes("Items")
          ? { type: "array", items: { type: "string" } }
          : { type: "object", additionalProperties: false, properties: {} };
    for (const value of ["12", {}, [], true, false, null, Number.MAX_SAFE_INTEGER + 1])
      probe(t, { ...base, [keyword]: value }, `${keyword}=${JSON.stringify(value)}`);
    if (counts.includes(keyword))
      for (const value of [-1, 0.5]) probe(t, { ...base, [keyword]: value }, `${keyword}=${value}`);
    for (const exponent of ["1e999", "-1e999"]) {
      const dir = workspace(t);
      modify(dir, commonPath, (s) => {
        s.$defs.SecurityProbe = { ...base, [keyword]: "overflowSentinel" };
      });
      const path = resolve(dir, commonPath);
      writeFileSync(path, readFileSync(path, "utf8").replace('"overflowSentinel"', exponent));
      rejected(dir, `${keyword} exponent overflow ${exponent}`);
    }
  }
  for (const node of [
    { type: "number", minimum: 2, maximum: 1 },
    { type: "number", exclusiveMinimum: 1, maximum: 1 },
    { type: "number", minimum: 1, exclusiveMaximum: 1 },
    { type: "integer", minimum: 0.2, maximum: 0.8 },
    { type: "string", minLength: 2, maxLength: 1 },
    { type: "array", items: { type: "string" }, minItems: 2, maxItems: 1 },
    { type: "object", additionalProperties: false, properties: {}, minProperties: 1 },
  ])
    probe(t, node, "Impossible bound combination");
});

test("QA40-F2 keyword/type matrix rejects every unsupported assertion combination", (t) => {
  const forms = {
    string: { type: "string" },
    number: { type: "number" },
    integer: { type: "integer" },
    boolean: { type: "boolean" },
    array: { type: "array", items: { type: "string" } },
    object: { type: "object", properties: {}, additionalProperties: false },
    $ref: { $ref: "#/$defs/Confidence" },
    oneOf: {
      oneOf: [
        {
          $ref: "https://editagent.local/schemas/media-analysis/1.0.0.schema.json#/$defs/MetadataNotAvailable",
        },
        {
          $ref: "https://editagent.local/schemas/media-analysis/1.0.0.schema.json#/$defs/MetadataFailed",
        },
      ],
    },
    allOf: { allOf: [{ type: "string" }, { type: "string", maxLength: 5 }] },
  };
  const keywords = {
    minimum: 0,
    maximum: 1,
    exclusiveMinimum: 0,
    exclusiveMaximum: 1,
    minLength: 0,
    maxLength: 1,
    minItems: 0,
    maxItems: 1,
    minProperties: 0,
    pattern: "^[a-z]*$(?![\\s\\S])",
    items: { type: "string" },
    properties: {},
    required: [],
    additionalProperties: false,
    "x-editagent-checks": [],
  };
  for (const [form, base] of Object.entries(forms))
    for (const [keyword, value] of Object.entries(keywords)) {
      if (!keywordMatrix[form].includes(keyword))
        probe(t, { ...base, [keyword]: value }, `${keyword} on ${form}`);
    }
});

test("QA40-F2 malformed rules, operands, paths, types and extra parameters fail closed", (t) => {
  const base = {
    type: "object",
    additionalProperties: false,
    properties: {
      left: { type: "number" },
      right: { type: "number" },
      text: { type: "string" },
      rows: { type: "array", items: { $ref: "#/$defs/TimeRange" } },
    },
    required: ["left", "right", "text", "rows"],
  };
  for (const rules of [
    null,
    {},
    "rules",
    [null],
    [[]],
    [1],
    [{ kind: "typo" }],
    [{ kind: "less", left: "left" }],
    [{ kind: "less", right: "right" }],
    [{ kind: "less", left: "left", right: "typo" }],
    [{ kind: "less", left: 1, right: "right" }],
    [{ kind: "less", left: "text", right: "right" }],
    [{ kind: "less", left: "left", right: "right", decimal: "false" }],
    [{ kind: "less", left: "left", right: "right", typo: true }],
    [{ kind: "positive", field: "missing.nested" }],
    [{ kind: "maximum", field: "left", value: "12" }],
    [{ kind: "maximum", field: "text", decimal: true, value: "1\n" }],
    [{ kind: "together", fields: "left" }],
    [{ kind: "together", fields: ["left", "typo"] }],
    [{ kind: "sumMax", fields: ["left"], maximum: false }],
    [{ kind: "unique", field: "rows", key: "typo" }],
    [{ kind: "unique", field: "left", key: "startUs" }],
    [{ kind: "nestedCount", field: "rows", child: "startUs", maximum: 1 }],
    [{ kind: "orderedRanges", field: "rows", start: "startUs", end: "missing" }],
    [{ kind: "pointsWithin", field: "rows", time: "startUs", lower: "text", upper: "missing" }],
    [{ kind: "timesWithin", duration: "text", fields: ["rows"], timeKeys: ["typo"] }],
  ])
    probe(t, { ...base, "x-editagent-checks": rules }, "Malformed rule contract");
  // Valid rule must not be ignored because one target doesn't execute it on this location.
  for (const type of ["array", "string"])
    probe(
      t,
      {
        type,
        ...(type === "array" ? { items: { type: "number" } } : {}),
        "x-editagent-checks": [{ kind: "positive", field: "left" }],
      },
      `Rule on ${type}`,
    );
  const dir = workspace(t);
  modify(dir, rootPath, (s) => {
    s.$defs.MetadataSection["x-editagent-checks"] = [{ kind: "less", left: "left" }];
  });
  rejected(dir, "Malformed rule on oneOf");
});

test("QA40-F2 Python identifiers and nonportable regular expressions are rejected", (t) => {
  for (const field of [
    "class",
    "from",
    "import",
    "lambda",
    "yield",
    "async",
    "await",
    "str",
    "int",
    "float",
    "bool",
    "list",
    "partial",
  ])
    probe(
      t,
      { type: "object", additionalProperties: false, properties: { [field]: { type: "string" } } },
      field,
    );
  for (const name of [
    "None",
    "Annotated",
    "Literal",
    "Self",
    "TypeAlias",
    "Field",
    "ContractModel",
  ]) {
    const dir = workspace(t);
    modify(dir, commonPath, (s) => {
      s.$defs[name] = { type: "string" };
    });
    rejected(dir, "Reserved Python type name");
  }
  for (const pattern of [
    "^\\p{L}+$",
    "^\\p{L}+$(?![\\s\\S])",
    "^\\d+$(?![\\s\\S])",
    "^\\w+$(?![\\s\\S])",
    "^\\s+$(?![\\s\\S])",
    "(?<name>a)",
    "(?<=a)b",
    "^.+$(?![\\s\\S])",
    "^[^]+$(?![\\s\\S])",
    "^[a-z&&x]+$(?![\\s\\S])",
    "^[a-z]{4294967296}$(?![\\s\\S])",
    "^[a-z]{4294967296,}$(?![\\s\\S])",
    "^[a-z]{4,2}$(?![\\s\\S])",
    1,
  ])
    probe(t, { type: "string", pattern }, "Nonportable regex");
});

test("QA40-F2 asymmetric and ambiguous schema shapes are rejected", (t) => {
  for (const node of [
    {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    },
    {
      type: "array",
      items: { allOf: [{ type: "object", properties: {}, additionalProperties: false }] },
    },
    { type: "string", const: "x" },
    { type: ["string"] },
    { const: "x", minLength: 2 },
    { const: "x", enum: ["x"] },
    { enum: ["x", 1] },
    { enum: [] },
    { const: 0.5 },
    { oneOf: [{ type: "string" }, { type: "number" }] },
    {
      allOf: [
        { type: "string", minLength: 3 },
        { type: "string", maxLength: 2 },
      ],
    },
    { allOf: [{ type: "number" }, { type: "number" }] },
    { type: "array", items: false },
    { type: "object", properties: {}, additionalProperties: true },
    { type: "object", properties: {}, additionalProperties: false, required: ["typo"] },
  ])
    probe(t, node, "Unsupported/ambiguous shape");
});

test("QA40-F2 every real rule kind rejects missing parameters before target emission", (t) => {
  const examples = new Map();
  function collect(node, file, route = []) {
    if (!node || typeof node !== "object") return;
    if (node["x-editagent-checks"])
      for (const [index, rule] of node["x-editagent-checks"].entries())
        if (!examples.has(rule.kind)) examples.set(rule.kind, { file, route, index, rule });
    for (const [key, child] of Object.entries(node)) {
      if (key === "x-editagent-checks") continue;
      if (child && typeof child === "object") collect(child, file, [...route, key]);
    }
  }
  for (const file of sourceFiles)
    collect(JSON.parse(readFileSync(resolve(root, file), "utf8")), file);
  assert.equal(examples.size, 15);
  for (const { file, route, index, rule } of examples.values())
    for (const parameter of Object.keys(rule)) {
      if (parameter === "kind" || parameter === "decimal") continue;
      const dir = workspace(t);
      modify(dir, file, (s) => {
        let node = s;
        for (const part of route) node = node[part];
        delete node["x-editagent-checks"][index][parameter];
      });
      rejected(dir, `${rule.kind} missing ${parameter}`);
    }
});

test("approved schema graph is unchanged, deterministic and passes both target drift checks", async () => {
  const first = await generate();
  assert.deepEqual(await generate(), first);
  for (const [file, bytes] of first) assert.equal(readFileSync(resolve(root, file), "utf8"), bytes);
  await run(root, true);
});

test("AC1 manual target edits and missing files fail; regeneration restores check without changing canonical sources", async (t) => {
  const dir = workspace(t);
  for (const target of targets) {
    writeFileSync(
      resolve(dir, target),
      readFileSync(resolve(dir, target), "utf8") + "\n# manual mutation\n",
    );
    await assert.rejects(run(dir, true), /Stale MediaAnalysis binding/);
    await run(dir, false);
    await run(dir, true);
    rmSync(resolve(dir, target));
    await assert.rejects(run(dir, true), /Stale MediaAnalysis binding/);
    await run(dir, false);
    await run(dir, true);
  }
  for (const file of sourceFiles)
    assert.deepEqual(readFileSync(resolve(dir, file)), readFileSync(resolve(root, file)));
  assert.match(
    JSON.parse(readFileSync(resolve(root, "package.json"))).scripts.build,
    /^pnpm schemas:check &&/,
  );
});

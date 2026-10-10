/** Repository-owned, fail-closed JSON Schema subset compiler, version 1.0.0. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import process from "node:process";
import console from "node:console";
import prettier from "prettier";

export const GENERATOR_VERSION = "1.0.0";
export const sourceFiles = [
  "media-time",
  "analysis-common",
  "analysis-provenance",
  "analysis-metadata",
  "analysis-transcript",
  "speech-analysis",
  "analysis-audio",
  "analysis-scenes",
  "analysis-faces",
  "analysis-objects",
  "media-analysis",
].map((n) => `packages/schemas/src/${n}.schema.json`);
export const targets = [
  "packages/schemas/src/media-analysis.generated.ts",
  "workers/ai-worker/src/editagent_ai_worker/contracts/media_analysis_generated.py",
];
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const allowed = new Set([
  "$schema",
  "$id",
  "$defs",
  "$ref",
  "title",
  "description",
  "type",
  "const",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "minProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "oneOf",
  "allOf",
  "x-editagent-checks",
]);
const kinds = new Set([
  "positive",
  "maximum",
  "less",
  "lessEqual",
  "sameWhenPresent",
  "together",
  "sumMax",
  "unique",
  "nestedCount",
  "orderedRanges",
  "orderedPoints",
  "rangesWithin",
  "pointsWithin",
  "timesWithin",
  "rotatedDimensions",
]);
const q = JSON.stringify;
const pascal = (value) => value.replace(/(^|[_-])([a-z])/g, (_, __, c) => c.toUpperCase());
const pythonLiteral = (value) =>
  typeof value === "boolean"
    ? value
      ? "True"
      : "False"
    : typeof value === "object" && value !== null
      ? Array.isArray(value)
        ? `[${value.map(pythonLiteral).join(", ")}]`
        : `{${Object.entries(value)
            .map(([k, v]) => `${q(k)}: ${pythonLiteral(v)}`)
            .join(", ")}}`
      : value === null
        ? "None"
        : q(value);

export async function generate(root = repositoryRoot) {
  const schemas = await Promise.all(
    sourceFiles.map(async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"))),
  );
  const registry = new Map(schemas.map((s) => [s.$id, s]));
  if (registry.size !== schemas.length) throw new Error("Schema ID collision");
  const names = new Map();
  const nodes = new Map();
  function register(node, name, owner) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) throw new Error("Unsafe generated type name");
    if (names.has(name) && names.get(name) !== node)
      throw new Error(`Generated name collision: ${name}`);
    names.set(name, node);
    nodes.set(node, { name, owner });
    if (node.properties)
      for (const [key, child] of Object.entries(node.properties)) {
        if (!/^[a-z][A-Za-z0-9]*$/.test(key)) throw new Error("Unsafe contract property name");
        if (child.type === "object") register(child, name + pascal(key), owner);
      }
  }
  for (const owner of schemas) {
    register(owner, owner.title, owner);
    for (const [name, node] of Object.entries(owner.$defs ?? {}))
      register(node, pascal(name), owner);
  }
  function referenced(ref, owner) {
    const [url, fragment = ""] = ref.split("#");
    const schema = url ? registry.get(url) : owner;
    if (!schema) throw new Error(`Unresolved offline schema reference: ${ref}`);
    let node = schema;
    if (fragment) {
      if (!fragment.startsWith("/")) throw new Error("Unsupported reference fragment");
      for (const key of fragment.slice(1).split("/")) node = node[key];
    }
    if (!node || !nodes.has(node)) throw new Error(`Unregistered schema reference: ${ref}`);
    return node;
  }
  function scalar(node, owner) {
    for (const key of Object.keys(node))
      if (!allowed.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
    if (node.$ref) {
      if (Object.keys(node).some((k) => k !== "$ref" && k !== "description"))
        throw new Error("Use supported scalar allOf for reference constraints");
      return scalar(referenced(node.$ref, owner), nodes.get(referenced(node.$ref, owner)).owner);
    }
    const annotations = ["$schema", "$id", "title", "description"];
    const permitted = node.allOf
      ? [...annotations, "allOf"]
      : [...annotations, "type", "minLength", "maxLength", "pattern"];
    if (Object.keys(node).some((key) => !permitted.includes(key)))
      throw new Error("Unsupported scalar intersection constraint");
    if (!node.allOf) return node;
    const parts = node.allOf.map((p) => scalar(p, owner));
    if (parts.some((p) => p.type !== "string"))
      throw new Error("Only scalar string intersections are supported");
    return {
      type: "string",
      minLength: Math.max(...parts.map((p) => p.minLength ?? 0)),
      maxLength: Math.min(...parts.map((p) => p.maxLength ?? Infinity)),
      patterns: parts.flatMap((p) => p.patterns ?? (p.pattern ? [p.pattern] : [])),
    };
  }
  const visiting = new Set();
  const emitted = new Set();
  const ts = [];
  const py = [];
  function emit(node) {
    if (emitted.has(node)) return;
    if (visiting.has(node)) throw new Error("Recursive contracts are not supported");
    visiting.add(node);
    const { name, owner } = nodes.get(node);
    const tsExpression = expression(node, owner, "ts", true);
    const pyExpression = expression(node, owner, "py", true);
    ts.push(
      `export const ${name}Schema = ${tsExpression};\nexport type ${name} = z.infer<typeof ${name}Schema>;`,
    );
    if (node.type === "object") {
      const required = new Set(node.required ?? []);
      const fields = Object.entries(node.properties).map(([key, child]) => {
        const value = expression(child, owner, "py");
        return `    ${key}: ${value}${required.has(key) ? "" : " | None = None"}`;
      });
      const rules = node["x-editagent-checks"] ?? [];
      let checks = "";
      if (rules.length || node.minProperties)
        checks = `\n    @model_validator(mode="after")\n    def validate_contract(self) -> Self:\n        if ${node.minProperties ? `len(self.model_fields_set) < ${node.minProperties} or ` : ""}not check_rules(self, ${pythonLiteral(rules)}):\n            raise ValueError("Canonical schema relational constraint failed")\n        return self\n`;
      py.push(`class ${name}(ContractModel):\n${fields.join("\n") || "    pass"}\n${checks}`);
    } else py.push(`${name}: TypeAlias = ${pyExpression}`);
    visiting.delete(node);
    emitted.add(node);
  }
  function expression(original, owner, language, self = false) {
    for (const key of Object.keys(original))
      if (!allowed.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
    const rules = original["x-editagent-checks"] ?? [];
    for (const rule of rules)
      if (!kinds.has(rule.kind)) throw new Error(`Unsupported contract rule: ${rule.kind}`);
    if (original.$ref) {
      if (Object.keys(original).some((k) => k !== "$ref" && k !== "description"))
        throw new Error("Use supported scalar allOf for reference constraints");
      const target = referenced(original.$ref, owner);
      emit(target);
      return nodes.get(target).name + (language === "ts" ? "Schema" : "");
    }
    if (!self && nodes.has(original)) {
      emit(original);
      return nodes.get(original).name + (language === "ts" ? "Schema" : "");
    }
    const node = original.allOf ? scalar(original, owner) : original;
    let result;
    if (
      (node.const !== undefined && !["string", "number", "boolean"].includes(typeof node.const)) ||
      node.enum?.some((v) => !["string", "number", "boolean"].includes(typeof v))
    )
      throw new Error("Only primitive const/enum values are supported");
    if (node.const !== undefined)
      result =
        language === "ts" ? `z.literal(${q(node.const)})` : `Literal[${pythonLiteral(node.const)}]`;
    else if (node.enum)
      result =
        language === "ts"
          ? `z.union([${node.enum.map((v) => `z.literal(${q(v)})`).join(",")}])`
          : `Literal[${node.enum.map(pythonLiteral).join(", ")}]`;
    else if (node.oneOf) {
      // Each branch has a disjoint required literal status; union and oneOf are equivalent.
      const statuses = node.oneOf.map((ref) => {
        const branch = referenced(ref.$ref, owner);
        if (!branch.required?.includes("status"))
          throw new Error("oneOf requires a required status");
        return branch.properties.status.const;
      });
      if (new Set(statuses).size !== statuses.length || statuses.some((s) => typeof s !== "string"))
        throw new Error("oneOf requires disjoint literal status branches");
      const values = node.oneOf.map((child) => expression(child, owner, language));
      result = language === "ts" ? `z.union([${values.join(",")}])` : values.join(" | ");
    } else if (node.type === "object") {
      if (node.additionalProperties !== false) throw new Error("Contracts must be strict objects");
      const required = new Set(node.required ?? []);
      if ([...required].some((k) => !Object.hasOwn(node.properties, k)))
        throw new Error("Required field is not defined");
      const fields = Object.entries(node.properties).map(
        ([key, child]) =>
          `${q(key)}: ${expression(child, owner, language)}${required.has(key) ? "" : ".optional()"}`,
      );
      result = language === "ts" ? `z.strictObject({${fields.join(",")}})` : "ContractModel";
      if (language === "ts" && node.minProperties)
        result += `.refine(value => Object.keys(value).length >= ${node.minProperties})`;
    } else if (node.type === "string") {
      const patterns = node.patterns ?? (node.pattern ? [node.pattern] : []);
      if (language === "ts") {
        result = "z.string().refine(wellFormed)";
        if (node.minLength !== undefined)
          result += `.refine(value => codePointLength(value) >= ${node.minLength})`;
        if (node.maxLength !== undefined && Number.isFinite(node.maxLength))
          result += `.refine(value => codePointLength(value) <= ${node.maxLength})`;
        for (const pattern of patterns) result += `.regex(new RegExp(${q(pattern)}, "u"))`;
      } else
        result = `Annotated[str, AfterValidator(partial(text_rules, minimum=${node.minLength ?? 0}, maximum=${node.maxLength === undefined || !Number.isFinite(node.maxLength) ? "None" : node.maxLength}, patterns=${pythonLiteral(
          patterns,
        )
          .replace(/^\[/, "(")
          .replace(/\]$/, patterns.length === 1 ? ",)" : ")")}))]`;
    } else if (["integer", "number"].includes(node.type)) {
      const integer = node.type === "integer";
      const constraints = [
        ["minimum", "ge", "min"],
        ["maximum", "le", "max"],
        ["exclusiveMinimum", "gt", "gt"],
        ["exclusiveMaximum", "lt", "lt"],
      ].filter(([key]) => node[key] !== undefined);
      if (language === "ts")
        result =
          "z.number().finite()" +
          (integer ? ".int()" : "") +
          constraints.map(([key, , method]) => `.${method}(${node[key]})`).join("");
      else
        result = `Annotated[${integer ? "int, BeforeValidator(json_integer)" : "float"}${constraints.length ? `, Field(${constraints.map(([key, arg]) => `${arg}=${node[key]}`).join(", ")})` : ""}]`;
    } else if (node.type === "boolean") result = language === "ts" ? "z.boolean()" : "bool";
    else if (node.type === "array") {
      const items = expression(node.items, owner, language);
      result =
        language === "ts"
          ? `z.array(${items})${node.minItems === undefined ? "" : `.min(${node.minItems})`}${node.maxItems === undefined ? "" : `.max(${node.maxItems})`}`
          : `Annotated[list[${items}], Field(min_length=${node.minItems ?? 0}${node.maxItems === undefined ? "" : `, max_length=${node.maxItems}`})]`;
    } else throw new Error("Unsupported schema shape");
    if (language === "ts" && rules.length)
      result += `.refine(value => checkRules(value, ${q(rules)}), "Canonical schema relational constraint failed")`;
    return result;
  }
  for (const node of nodes.keys()) emit(node);
  const digest = createHash("sha256").update(JSON.stringify(schemas)).digest("hex");
  const header = `GENERATED FILE — DO NOT EDIT.\nCanonical sources: packages/schemas/src/{media,analysis,speech}*.schema.json\nGenerator: tools/schema/generate-media-analysis.mjs v${GENERATOR_VERSION}; pnpm schemas:generate\nSource SHA-256: ${digest}`;
  const tsOutput = await prettier.format(
    `/** ${header.replaceAll("\n", "\n * ")} */\nimport { z } from "zod";\nimport {checkRules, codePointLength, wellFormed} from "./analysis-validation.js";\n${ts.join("\n\n")}\n`,
    { parser: "typescript", printWidth: 100 },
  );
  const pyOutput = `"""${header}"""\n\n# fmt: off\n# ruff: noqa: E501\nfrom __future__ import annotations\n\nfrom functools import partial\nfrom typing import Annotated, Literal, Self, TypeAlias\n\nfrom pydantic import AfterValidator, BeforeValidator, Field, model_validator\n\nfrom .validation import ContractModel, check_rules, json_integer, text_rules\n\n${py.join("\n\n").trimEnd()}\n`;
  return new Map([
    [targets[0], tsOutput],
    [targets[1], pyOutput],
  ]);
}
export async function run(root = repositoryRoot, check = false) {
  const output = await generate(root);
  for (const [path, expected] of output) {
    if (check) {
      const actual = await readFile(resolve(root, path), "utf8").catch(() => null);
      if (actual !== expected)
        throw new Error(`Stale MediaAnalysis binding: ${path}. Run pnpm schemas:generate.`);
    } else {
      await mkdir(dirname(resolve(root, path)), { recursive: true });
      await writeFile(resolve(root, path), expected);
    }
  }
  return output;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const check = args.includes("--check");
    const rest = args.filter((arg) => arg !== "--check");
    if (rest.length && (rest.length !== 2 || rest[0] !== "--root"))
      throw new Error("Usage: generate-media-analysis [--check] [--root DIRECTORY]");
    await run(rest.length ? resolve(rest[1]) : repositoryRoot, check);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

import { uuidV7 } from "@editagent/domain";
import { createHash } from "node:crypto";
import Ajv2020, { type ValidateFunction, type ErrorObject } from "ajv/dist/2020.js";

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "ToolError";
    // Public SDK failures contain only sanitized diagnostics, never internal stack frames.
    this.stack = `ToolError: ${message}`;
  }
}
export type JsonSchema = Readonly<Record<string, unknown>>;
/** Data is JSON, never executable objects/getters/classes. Bounded before validation/hash. */
export function jsonValue(value: unknown): unknown {
  let nodes = 0;
  let bytes = 0;
  const charge = (size: number) => {
    bytes += size;
    if (bytes > 1_048_576) throw new ToolError("invalid_json", "JSON exceeds byte limit");
  };
  const stringSize = (s: string) => {
    if (s.length > 1_048_576) throw new ToolError("invalid_json", "JSON exceeds byte limit");
    return Buffer.byteLength(JSON.stringify(s));
  };
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > 100_000 || depth > 32)
      throw new ToolError("invalid_json", "JSON exceeds structural limits");
    if (v === null || typeof v === "boolean") {
      charge(v === null || v === true ? 4 : 5);
      return v;
    }
    if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) {
      charge(JSON.stringify(v).length);
      return v;
    }
    if (typeof v === "string") {
      charge(stringSize(v));
      if (!wellFormed(v)) throw new ToolError("invalid_json", "Ill-formed Unicode");
      return v;
    }
    if (Array.isArray(v)) {
      if (Object.keys(v).length !== v.length)
        throw new ToolError("invalid_json", "Sparse or extended array");
      charge(2 + Math.max(0, v.length - 1));
      return Array.from({ length: v.length }, (_, i) => {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d || !("value" in d)) throw new ToolError("invalid_json", "Executable array property");
        return visit(d.value, depth + 1);
      });
    }
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      const result: Record<string, unknown> = {};
      charge(2);
      let first = true;
      for (const key of Object.keys(v).sort()) {
        charge(stringSize(key) + 1 + (first ? 0 : 1));
        if (["__proto__", "constructor", "prototype"].includes(key) || !wellFormed(key))
          throw new ToolError("invalid_json", "Forbidden property");
        first = false;
        const d = Object.getOwnPropertyDescriptor(v, key)!;
        if (!("value" in d)) throw new ToolError("invalid_json", "Executable property");
        result[key] = visit(d.value, depth + 1);
      }
      return result;
    }
    throw new ToolError("invalid_json", "Expected finite canonical JSON");
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > 1_048_576)
    throw new ToolError("invalid_json", "JSON exceeds byte limit");
  return result;
}
export function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(++i);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
export function canonicalJson(v: unknown): string {
  return JSON.stringify(jsonValue(v));
}
export function contentHash(v: unknown): string {
  return createHash("sha256").update(canonicalJson(v)).digest("hex");
}
export function freeze<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const c of Object.values(v)) freeze(c);
    Object.freeze(v);
  }
  return v;
}
/** Intentionally small offline 2020-12 subset, identical schema exported to the LLM. */
export function compileSchema(schema: JsonSchema): ValidateFunction {
  const safe = jsonValue(schema) as Record<string, unknown>;
  const visit = (s: Record<string, unknown>, depth: number) => {
    if (depth > 16) throw new ToolError("invalid_schema");
    const common = ["type", "description", "const", "enum"];
    const byType: Record<string, string[]> = {
      string: ["minLength", "maxLength", "pattern"],
      number: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"],
      integer: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"],
      boolean: [],
      null: [],
      object: ["properties", "required", "additionalProperties", "minProperties", "maxProperties"],
      array: ["items", "minItems", "maxItems", "uniqueItems"],
    };
    if (typeof s.type !== "string" || !byType[s.type])
      throw new ToolError("invalid_schema", "Unsupported schema type");
    const allowed = [...common, ...byType[s.type]!];
    if (Object.keys(s).some((k) => !allowed.includes(k)))
      throw new ToolError("invalid_schema", "Unsupported schema keyword or reference");
    if (s.type === "object") {
      if (
        s.additionalProperties !== false ||
        !s.properties ||
        typeof s.properties !== "object" ||
        Array.isArray(s.properties)
      )
        throw new ToolError("invalid_schema", "Objects must be closed");
      for (const child of Object.values(s.properties))
        visit(child as Record<string, unknown>, depth + 1);
    }
    if (s.type === "array") {
      if (!Number.isSafeInteger(s.maxItems) || (s.maxItems as number) > 10_000)
        throw new ToolError("invalid_schema", "Arrays require bounded maxItems");
      if (!s.items || typeof s.items !== "object") throw new ToolError("invalid_schema");
      visit(s.items as Record<string, unknown>, depth + 1);
    }
    if (
      s.type === "string" &&
      (!Number.isSafeInteger(s.maxLength) || (s.maxLength as number) > 65_536)
    )
      throw new ToolError("invalid_schema", "Strings require bounded maxLength");
    if (s.pattern !== undefined) {
      if (
        typeof s.pattern !== "string" ||
        s.pattern.length > 256 ||
        /[(){}*]|\\[1-9]/.test(s.pattern) ||
        (s.pattern.match(/\+/g)?.length ?? 0) > 1
      )
        throw new ToolError("invalid_schema", "Unsupported regular expression");
      new RegExp(s.pattern, "u");
    }
    for (const k of [
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
      "minProperties",
      "maxProperties",
    ]) {
      if (
        s[k] !== undefined &&
        (typeof s[k] !== "number" ||
          !Number.isFinite(s[k]) ||
          Math.abs(s[k] as number) > Number.MAX_SAFE_INTEGER ||
          ((k.startsWith("min") || k.startsWith("max")) &&
            !["minimum", "maximum"].includes(k) &&
            (!Number.isSafeInteger(s[k]) || (s[k] as number) < 0)))
      )
        throw new ToolError("invalid_schema", `Invalid ${k}`);
    }
    for (const [min, max] of [
      ["minimum", "maximum"],
      ["minLength", "maxLength"],
      ["minItems", "maxItems"],
      ["minProperties", "maxProperties"],
    ])
      if (
        typeof s[min!] === "number" &&
        typeof s[max!] === "number" &&
        (s[min!] as number) > (s[max!] as number)
      )
        throw new ToolError("invalid_schema", "Inverted bounds");
  };
  visit(safe, 0);
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  if (!ajv.validateSchema(safe)) throw new ToolError("invalid_schema", "Invalid JSON Schema");
  return ajv.compile(safe);
}
export function validate(validator: ValidateFunction, value: unknown, phase: string): unknown {
  const safe = jsonValue(value);
  if (!validator(safe)) {
    const errors = schemaDiagnostics(validator.errors, validator.schema as JsonSchema);
    throw new ToolError(`invalid_${phase}`, `${phase}: ${JSON.stringify(errors)}`);
  }
  return freeze(safe);
}

/** Only repository-defined properties and numeric array indices enter public paths.
 * Closed-object additional keys are caller data, even when they look like useful field names. */
export function schemaDiagnostics(
  errors: readonly ErrorObject[] | null | undefined,
  schema: JsonSchema,
) {
  return errors?.map((e) => {
    const encode = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
    let node: JsonSchema | undefined = schema;
    const path: string[] = [];
    for (const segment of e.instancePath.split("/").slice(1)) {
      const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
      if (node?.type === "array" && /^(0|[1-9][0-9]*)$/.test(key)) {
        path.push(key);
        node = node.items as JsonSchema;
      } else if (
        node?.type === "object" &&
        node.properties &&
        Object.hasOwn(node.properties as object, key)
      ) {
        path.push(encode(key));
        node = (node.properties as Record<string, JsonSchema>)[key];
      } else {
        path.push("[untrusted-property]");
        node = undefined;
      }
    }
    if (e.keyword === "additionalProperties") path.push("[additional-property]");
    else if (e.keyword === "required") {
      const key: unknown = e.params.missingProperty;
      path.push(
        typeof key === "string" && node?.properties && Object.hasOwn(node.properties as object, key)
          ? encode(key)
          : "[untrusted-property]",
      );
    }
    return { field: path.length ? "/" + path.join("/") : "/", rule: e.keyword };
  });
}

/** Only SDK-owned codes enter durable records/job reasons; implementation messages never do. */
export function safeErrorCode(code: unknown): string {
  const allowed = [
    "invalid_identity",
    "invalid_json",
    "invalid_schema",
    "invalid_manifest",
    "invalid_binding",
    "duplicate_tool",
    "unknown_tool",
    "invalid_input",
    "invalid_output",
    "invalid_call",
    "denied",
    "budget_exceeded",
    "capacity_exceeded",
    "invalid_subject",
    "invalid_commands",
    "invalid_cost",
    "cancelled",
    "timed_out",
    "remote_unavailable",
    "remote_missing",
    "remote_failed",
    "remote_result_missing",
    "remote_binding_mismatch",
    "remote_implementation_unavailable",
    "remote_result_conflict",
    "invalid_remote_envelope",
    "invalid_progress",
    "worker_failed",
    "worker_stopped",
    "invalid_worker_result",
    "execution_failed",
    "cleanup_unconfirmed",
    "audit_recovery_failed",
    "invalid_query",
    "audit_missing",
  ];
  return typeof code === "string" && allowed.includes(code) ? code : "execution_failed";
}

export function checkedId(value: string): string {
  if (typeof value !== "string" || value.length !== 36) throw new ToolError("invalid_identity");
  return uuidV7(value);
}

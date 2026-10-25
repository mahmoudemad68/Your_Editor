import { readFileSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { contentHash, canonicalJson } from "@editagent/tool-sdk";

export type PromptFailure =
  | "invalid_template"
  | "duplicate_prompt"
  | "prompt_not_found"
  | "invalid_variables"
  | "bundle_unavailable";
export class PromptError extends Error {
  constructor(readonly code: PromptFailure) {
    super(code);
  }
}
export interface PromptMetadata {
  schemaVersion: "1.0.0";
  id: string;
  version: string;
  purpose: string;
  variables: Record<
    string,
    { type: "string"; required: boolean; trust: "data" | "enum"; values?: string[] }
  >;
}
export interface PromptProvenance {
  promptId: string;
  promptVersion: string;
  templateHash: string;
  renderingHash: string;
}
export interface RenderedPrompt {
  instructions: string;
  untrustedData: Readonly<Record<string, string>>;
  provenance: Readonly<PromptProvenance>;
}
const name = /^[a-z][a-z0-9_-]{0,47}$/;
const version = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/;
const plain = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v));
function exact(v: Record<string, unknown>, keys: string[]) {
  return Object.keys(v).sort().join() === keys.sort().join();
}
/** JSON data is never interpolated into instruction authority. Angle brackets,
 * line controls and bidi controls cannot escape the separate serialized field. */
export function isolatedJson(value: unknown): string {
  return canonicalJson(value).replace(
    /[<>&\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}
export class PromptTemplate {
  readonly metadata: Readonly<PromptMetadata>;
  readonly templateHash: string;
  private readonly body: string;
  constructor(source: string) {
    try {
      if (
        typeof source !== "string" ||
        Buffer.byteLength(source) > 32768 ||
        source.includes("\r") ||
        !source.startsWith("---\n")
      )
        throw 0;
      const end = source.indexOf("\n---\n", 4);
      if (end < 0) throw 0;
      const m: unknown = JSON.parse(source.slice(4, end));
      if (
        !plain(m) ||
        !exact(m, ["schemaVersion", "id", "version", "purpose", "variables"]) ||
        m.schemaVersion !== "1.0.0" ||
        typeof m.id !== "string" ||
        !name.test(m.id) ||
        typeof m.version !== "string" ||
        !version.test(m.version) ||
        typeof m.purpose !== "string" ||
        !/^[a-zA-Z0-9 .,()-]{1,240}$/.test(m.purpose) ||
        !plain(m.variables) ||
        Object.keys(m.variables).length > 16
      )
        throw 0;
      if (JSON.stringify(m) !== source.slice(4, end)) throw 0;
      const specs = m.variables;
      for (const [key, v] of Object.entries(specs)) {
        if (
          !name.test(key) ||
          ["constructor", "prototype", "__proto__"].includes(key) ||
          !plain(v) ||
          !exact(
            v,
            v.trust === "enum"
              ? ["type", "required", "trust", "values"]
              : ["type", "required", "trust"],
          ) ||
          v.type !== "string" ||
          typeof v.required !== "boolean" ||
          !["data", "enum"].includes(String(v.trust))
        )
          throw 0;
        if (
          v.trust === "enum" &&
          (!Array.isArray(v.values) ||
            v.values.length < 1 ||
            v.values.length > 16 ||
            v.values.some((x) => typeof x !== "string" || !name.test(x)) ||
            new Set(v.values).size !== v.values.length)
        )
          throw 0;
      }
      const body = source.slice(end + 5);
      if (!body.trim() || body.length > 16384 || /\{[%#]|[%#]\}|\$\{|<script/i.test(body)) throw 0;
      const slots = [...body.matchAll(/\{\{([a-z][a-z0-9_-]{0,47})\}\}/g)].map((x) => x[1]!);
      if (
        slots.some((x) => !Object.hasOwn(specs, x)) ||
        Object.keys(specs).some((x) => !slots.includes(x)) ||
        /\{\{|\}\}/.test(body.replace(/\{\{[a-z][a-z0-9_-]{0,47}\}\}/g, ""))
      )
        throw 0;
      this.metadata = deepFreeze(m as unknown as PromptMetadata);
      this.body = body;
      this.templateHash = createHash("sha256").update(source, "utf8").digest("hex");
      Object.freeze(this);
    } catch {
      throw new PromptError("invalid_template");
    }
  }
  render(variables: Readonly<Record<string, string>>): Readonly<RenderedPrompt> {
    if (
      !plain(variables) ||
      Object.keys(variables).some((k) => !Object.hasOwn(this.metadata.variables, k))
    )
      throw new PromptError("invalid_variables");
    const data: Record<string, string> = {};
    for (const [key, spec] of Object.entries(this.metadata.variables)) {
      const v = variables[key];
      if (v === undefined && !spec.required) continue;
      if (
        typeof v !== "string" ||
        /[\ud800-\udfff]/u.test(v) ||
        Buffer.byteLength(v) > 4096 ||
        (spec.trust === "enum" && !spec.values!.includes(v))
      )
        throw new PromptError("invalid_variables");
      if (spec.trust === "data") data[key] = v;
    }
    const instructions = this.body.replace(/\{\{([a-z][a-z0-9_-]{0,47})\}\}/g, (_, k: string) =>
      this.metadata.variables[k]!.trust === "data"
        ? `[untrusted-data:${k}]`
        : (variables[k] ?? "unspecified"),
    );
    const renderingHash = contentHash({ instructions, untrustedData: data });
    return deepFreeze({
      instructions,
      untrustedData: data,
      provenance: {
        promptId: this.metadata.id,
        promptVersion: this.metadata.version,
        templateHash: this.templateHash,
        renderingHash,
      },
    });
  }
}
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value))
      if (child && typeof child === "object") deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
export class PromptRegistry {
  private readonly templates = new Map<string, PromptTemplate>();
  constructor(sources: readonly string[]) {
    if (!Array.isArray(sources) || sources.length < 1 || sources.length > 64)
      throw new PromptError("bundle_unavailable");
    for (const source of sources) {
      const t = new PromptTemplate(source),
        key = `${t.metadata.id}@${t.metadata.version}`;
      if (this.templates.has(key)) throw new PromptError("duplicate_prompt");
      this.templates.set(key, t);
    }
  }
  load(id: string, pinnedVersion: string): PromptTemplate {
    if (
      typeof id !== "string" ||
      !name.test(id) ||
      typeof pinnedVersion !== "string" ||
      !version.test(pinnedVersion)
    )
      throw new PromptError("prompt_not_found");
    const t = this.templates.get(`${id}@${pinnedVersion}`);
    if (!t) throw new PromptError("prompt_not_found");
    return t;
  }
}
/** Trusted deployment path only, never a request parameter. Reject links and
 * nested/unknown files; each filename must match its validated metadata. */
export function loadPromptDirectory(directory: string): PromptRegistry {
  try {
    if (lstatSync(directory).isSymbolicLink()) throw 0;
    const root = realpathSync(directory),
      files = readdirSync(root).sort();
    if (files.length > 64) throw 0;
    return new PromptRegistry(
      files.map((file) => {
        if (!/^[a-z][a-z0-9_-]{0,47}@[0-9]+\.[0-9]+\.[0-9]+\.prompt$/.test(file)) throw 0;
        const p = path.join(root, file),
          stat = lstatSync(p);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size > 32768 ||
          path.dirname(realpathSync(p)) !== root
        )
          throw 0;
        const text = readFileSync(p, "utf8"),
          t = new PromptTemplate(text);
        if (file !== `${t.metadata.id}@${t.metadata.version}.prompt`) throw 0;
        return text;
      }),
    );
  } catch {
    throw new PromptError("bundle_unavailable");
  }
}
export const packagedPrompts = (): PromptRegistry =>
  loadPromptDirectory(path.join(__dirname, "prompts"));

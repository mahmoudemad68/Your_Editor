import Ajv2020 from "ajv/dist/2020.js";
import { toolManifestSchema } from "@editagent/schemas";
import { toolId } from "@editagent/domain";
import { type ValidateFunction } from "ajv";
import {
  ToolError,
  compileSchema,
  contentHash,
  freeze,
  jsonValue,
  validate,
  schemaDiagnostics,
  type JsonSchema,
} from "./validation.js";

export type ToolPermission =
  "project.read" | "timeline.propose" | "asset.read" | "analysis.read" | "render.create";
export type ToolCapability = "editing" | "render" | "audio" | "vision" | "transcription";
export interface ToolManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly permissions: readonly ToolPermission[];
  readonly capabilities: readonly ToolCapability[];
  readonly estimatedCostMicros: number;
  readonly maximumCostMicros: number;
  readonly timeoutMs: number;
  readonly mutating: boolean;
  /** Named relational checks: enforced by validateInput/validateOutput, never exported as executable code. */
  readonly validationRules: readonly {
    readonly phase: "input" | "output";
    readonly kind: "ordered";
    readonly start: string;
    readonly end: string;
  }[];
}
export interface ToolContext {
  readonly executionId: string;
  readonly callerId: string;
  readonly projectId: string;
  readonly resource: { readonly kind: "project" | "asset" | "timeline"; readonly id: string };
  readonly signal: AbortSignal;
  readonly progress: (percentage: number) => Promise<void>;
}
export interface ToolResult {
  readonly output: unknown;
  readonly costMicros: number;
}
/** Trusted cooperative implementations. cancel MUST acknowledge owned-work cleanup. Heavy/noncooperative work uses an isolated runner. */
export interface OwnedToolRun {
  readonly result: Promise<ToolResult>;
  cancel(): Promise<void>;
  /** Independently owned escalation, if graceful cleanup fails. Never a broad process kill. */
  forceStop?(): Promise<void>;
}
export interface ITool {
  start(input: unknown, context: ToolContext): OwnedToolRun;
}
export interface IAudioTool extends ITool {
  readonly capability: "audio";
}
export interface IRenderTool extends ITool {
  readonly capability: "render";
}
export interface IVisionTool extends ITool {
  readonly capability: "vision";
}
export interface ITranscriptionTool extends ITool {
  readonly capability: "transcription";
}
export type ToolBinding =
  | { readonly mode: "in-process"; readonly tool: ITool }
  | { readonly mode: "remote"; readonly target: "media" | "ai" | "render" };
export interface RegisteredTool {
  readonly manifest: ToolManifest;
  readonly fingerprint: string;
  readonly binding: ToolBinding;
  readonly input: ValidateFunction;
  readonly output: ValidateFunction;
}
const validateManifest = new Ajv2020({ strict: true, allErrors: true }).compile(toolManifestSchema);
const permissions: readonly string[] = [
  "project.read",
  "timeline.propose",
  "asset.read",
  "analysis.read",
  "render.create",
];
const capabilities: readonly string[] = ["editing", "render", "audio", "vision", "transcription"];
const functionName = (m: Pick<ToolManifest, "name" | "version">): string =>
  `${m.name.replace(".", "__")}__${m.version.replaceAll(".", "_")}`;
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  register(manifest: ToolManifest, binding: ToolBinding): void {
    const m = jsonValue(manifest) as ToolManifest;
    if (!validateManifest(m))
      throw new ToolError(
        "invalid_manifest",
        "Manifest field/rule: " + JSON.stringify(schemaDiagnostics(validateManifest.errors)),
      );
    if (
      Object.keys(m).sort().join() !==
      [
        "schemaVersion",
        "id",
        "name",
        "version",
        "description",
        "inputSchema",
        "outputSchema",
        "permissions",
        "capabilities",
        "estimatedCostMicros",
        "maximumCostMicros",
        "timeoutMs",
        "mutating",
        "validationRules",
      ]
        .sort()
        .join()
    )
      throw new ToolError("invalid_manifest");
    toolId(m.id);
    if (m.inputSchema.type !== "object")
      throw new ToolError(
        "invalid_manifest",
        "Function-calling input must be a closed object schema",
      );
    if (
      m.schemaVersion !== 1 ||
      !/^[a-z][a-z0-9-]{0,23}\.[a-z][a-z0-9-]{0,23}$/.test(m.name) ||
      !/^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/.test(m.version) ||
      typeof m.description !== "string" ||
      m.description.trim().length === 0 ||
      m.description.length > 2048 ||
      functionName(m).length > 64 ||
      typeof m.mutating !== "boolean"
    )
      throw new ToolError("invalid_manifest");
    for (const [values, allowed] of [
      [m.permissions, permissions],
      [m.capabilities, capabilities],
    ] as const)
      if (
        !Array.isArray(values) ||
        values.length > 16 ||
        new Set(values).size !== values.length ||
        values.some((x) => !allowed.includes(x))
      )
        throw new ToolError("invalid_manifest", "Forbidden permission/capability");
    if (
      !m.permissions.includes("project.read") ||
      (m.mutating && !m.permissions.includes("timeline.propose"))
    )
      throw new ToolError("invalid_manifest", "Missing declared authority");
    for (const n of [m.estimatedCostMicros, m.maximumCostMicros, m.timeoutMs])
      if (!Number.isSafeInteger(n) || n < 0) throw new ToolError("invalid_manifest");
    if (m.timeoutMs < 1 || m.timeoutMs > 600_000 || m.maximumCostMicros < m.estimatedCostMicros)
      throw new ToolError("invalid_manifest");
    if (!Array.isArray(m.validationRules) || m.validationRules.length > 32)
      throw new ToolError("invalid_manifest");
    for (const rule of m.validationRules) {
      if (
        Object.keys(rule).sort().join() !== ["phase", "kind", "start", "end"].sort().join() ||
        !["input", "output"].includes(rule.phase) ||
        rule.kind !== "ordered"
      )
        throw new ToolError("invalid_manifest");
      const schema = rule.phase === "input" ? m.inputSchema : m.outputSchema;
      const p = schema.properties as Record<string, Record<string, unknown>> | undefined;
      if (
        !p ||
        !p[rule.start] ||
        !p[rule.end] ||
        p[rule.start]!.type !== p[rule.end]!.type ||
        !["integer", "number"].includes(String(p[rule.start]!.type)) ||
        !(schema.required as string[] | undefined)?.includes(rule.start) ||
        !(schema.required as string[] | undefined)?.includes(rule.end)
      )
        throw new ToolError(
          "invalid_manifest",
          "Relational rule fields must be required numeric properties",
        );
    }
    if (
      !binding ||
      (binding.mode !== "in-process" && binding.mode !== "remote") ||
      (binding.mode === "remote" && !["media", "ai", "render"].includes(binding.target)) ||
      (binding.mode === "in-process" && typeof binding.tool?.start !== "function")
    )
      throw new ToolError("invalid_binding");
    const key = `${m.name}@${m.version}`;
    if (
      this.tools.has(key) ||
      [...this.tools.values()].some(
        (t) =>
          (t.manifest.id === m.id && t.manifest.name !== m.name) ||
          (t.manifest.name === m.name && t.manifest.id !== m.id),
      )
    )
      throw new ToolError("duplicate_tool");
    const input = compileSchema(m.inputSchema),
      output = compileSchema(m.outputSchema);
    this.tools.set(
      key,
      Object.freeze({
        manifest: freeze(m),
        fingerprint: contentHash(m),
        binding: Object.freeze({ ...binding }),
        input,
        output,
      }),
    );
  }
  lookup(name: string, version: string): RegisteredTool {
    const t = this.tools.get(`${name}@${version}`);
    if (!t) throw new ToolError("unknown_tool");
    return t;
  }
  discover(capability?: ToolCapability): readonly ToolManifest[] {
    return Object.freeze(
      [...this.tools.values()]
        .filter((t) => !capability || t.manifest.capabilities.includes(capability))
        .map((t) => t.manifest)
        .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, "en")),
    );
  }
  exportFunctions(): readonly unknown[] {
    return this.discover().map((m) => ({
      type: "function",
      function: {
        name: functionName(m),
        description: m.description,
        parameters: m.inputSchema,
      },
      "x-editagent": {
        name: m.name,
        version: m.version,
        outputSchema: m.outputSchema,
        validationRules: m.validationRules,
      },
    }));
  }
  validate(t: RegisteredTool, phase: "input" | "output", value: unknown): unknown {
    const safe = validate(t[phase], value, phase) as Record<string, unknown>;
    for (const rule of t.manifest.validationRules.filter((r) => r.phase === phase))
      if (!((safe[rule.start] as number) < (safe[rule.end] as number)))
        throw new ToolError(
          `invalid_${phase}`,
          `${phase}: /${rule.start},/${rule.end} rule ordered`,
        );
    return safe;
  }
}

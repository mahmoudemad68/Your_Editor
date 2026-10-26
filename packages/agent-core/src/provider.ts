import { contentHash, jsonValue } from "@editagent/tool-sdk";
import { deepFreeze } from "./prompts.js";

export type ProviderMode = "chat" | "tools" | "structured" | "vision";
export type ProviderFailure =
  | "invalid_request"
  | "unsupported_mode"
  | "invalid_response"
  | "refused"
  | "truncated"
  | "cancelled"
  | "timeout"
  | "rate_limited"
  | "unavailable"
  | "authentication"
  | "transport_unknown"
  | "budget_exceeded"
  | "endpoint_denied";
export class ProviderError extends Error {
  constructor(readonly code: ProviderFailure) {
    super(code);
    this.name = "ProviderError";
    this.stack = `ProviderError: ${code}`;
  }
}
export interface ProviderCapabilities {
  readonly schemaVersion: "1.0.0";
  readonly provider: "openai-compatible" | "anthropic" | "replay";
  readonly modelId: string;
  readonly modelVersion: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly modes: readonly ProviderMode[];
  readonly tokenizer: { readonly kind: "conservative_utf8_bytes"; readonly version: "1" };
  readonly evidence: "operator_declared_unqualified" | "offline_http_fixture" | "synthetic_replay";
  readonly configurationVersion: string;
  readonly pricing: null | {
    readonly version: string;
    readonly provenance: "operator_declared" | "synthetic_fixture";
    readonly inputMicrosPerMillionTokens: number;
    readonly outputMicrosPerMillionTokens: number;
  };
}
export interface ModelMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}
export interface ModelTool {
  readonly name: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}
export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
  readonly maxOutputTokens: number;
  readonly deadlineAtMs: number;
  readonly tools?: readonly ModelTool[];
  readonly format?: { readonly name: string; readonly schema: Readonly<Record<string, unknown>> };
  readonly images?: readonly {
    readonly mediaType: "image/png" | "image/jpeg";
    readonly base64: string;
  }[];
}
export interface ModelToolCall {
  readonly idSha256: string;
  readonly name: string;
  readonly arguments: unknown;
}
export interface ModelUsage {
  readonly source:
    "provider_reported" | "offline_http_fixture" | "synthetic_replay" | "unavailable";
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  // Neither protocol provides a trustworthy billed-cost field in this contract.
  readonly actualCostMicros: null;
  readonly tokenAccounting:
    "provider_reported_total" | "native_input_and_cache_sum" | "synthetic_replay" | "unavailable";
}
export interface ProviderReceipt {
  readonly schemaVersion: "1.0.0";
  readonly provider: ProviderCapabilities["provider"];
  readonly modelId: string;
  readonly modelVersion: string;
  readonly profileSha256: string;
  readonly requestSha256: string;
  readonly requestIdSha256: string | null;
  readonly mode: ProviderMode;
  readonly evidence: ProviderCapabilities["evidence"];
  readonly usage: ModelUsage;
  readonly estimatedInputTokens: number;
  readonly estimatedCostMicros: number | null;
  readonly pricingVersion: string | null;
  readonly attempts: number;
  readonly durationMs: number;
  readonly deadlineAtMs: number;
}
export interface ModelReply {
  readonly text: string | null;
  readonly calls: readonly ModelToolCall[];
  readonly structured: unknown;
  readonly receipt: ProviderReceipt;
}
export interface IChatModel {
  readonly capabilities: ProviderCapabilities;
  chat(request: ModelRequest, signal: AbortSignal): Promise<ModelReply>;
}
export interface IToolCallingModel {
  readonly capabilities: ProviderCapabilities;
  tools(request: ModelRequest, signal: AbortSignal): Promise<ModelReply>;
}
export interface IStructuredOutputModel {
  readonly capabilities: ProviderCapabilities;
  structured(request: ModelRequest, signal: AbortSignal): Promise<ModelReply>;
}
export interface IVisionModel {
  readonly capabilities: ProviderCapabilities;
  vision(request: ModelRequest, signal: AbortSignal): Promise<ModelReply>;
}
export interface LanguageModel
  extends IChatModel, IToolCallingModel, IStructuredOutputModel, IVisionModel {}

const label = (s: unknown): s is string =>
  typeof s === "string" && /^[a-zA-Z0-9_.:/-]{1,100}$/.test(s);
export const natural = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
export function checkedCapabilities(value: ProviderCapabilities): ProviderCapabilities {
  try {
    const c = jsonValue(value) as unknown as ProviderCapabilities;
    if (
      c.schemaVersion !== "1.0.0" ||
      !["openai-compatible", "anthropic", "replay"].includes(c.provider) ||
      !label(c.modelId) ||
      !label(c.modelVersion) ||
      !label(c.configurationVersion) ||
      !natural(c.contextWindow) ||
      c.contextWindow < 1024 ||
      c.contextWindow > 2_000_000 ||
      !natural(c.maxOutputTokens) ||
      c.maxOutputTokens < 1 ||
      c.maxOutputTokens > c.contextWindow ||
      !Array.isArray(c.modes) ||
      c.modes.length === 0 ||
      new Set(c.modes).size !== c.modes.length ||
      c.modes.some((m) => !["chat", "tools", "structured", "vision"].includes(m)) ||
      c.tokenizer?.kind !== "conservative_utf8_bytes" ||
      c.tokenizer.version !== "1" ||
      !["operator_declared_unqualified", "offline_http_fixture", "synthetic_replay"].includes(
        c.evidence,
      ) ||
      (c.provider === "replay") !== (c.evidence === "synthetic_replay") ||
      (c.pricing !== null &&
        (!label(c.pricing.version) ||
          !["operator_declared", "synthetic_fixture"].includes(c.pricing.provenance) ||
          !natural(c.pricing.inputMicrosPerMillionTokens) ||
          c.pricing.inputMicrosPerMillionTokens > 1e9 ||
          !natural(c.pricing.outputMicrosPerMillionTokens) ||
          c.pricing.outputMicrosPerMillionTokens > 1e9))
    )
      throw new ProviderError("invalid_request");
    return deepFreeze(c);
  } catch {
    throw new ProviderError("invalid_request");
  }
}
export function checkedRequest(
  c: ProviderCapabilities,
  mode: ProviderMode,
  value: ModelRequest,
): ModelRequest {
  try {
    const r = jsonValue(value) as unknown as ModelRequest;
    if (!c.modes.includes(mode)) throw new ProviderError("unsupported_mode");
    const allowed = ["messages", "maxOutputTokens", "deadlineAtMs", "tools", "format", "images"];
    if (
      Object.keys(r).some((k) => !allowed.includes(k)) ||
      !natural(r.maxOutputTokens) ||
      r.maxOutputTokens < 1 ||
      r.maxOutputTokens > c.maxOutputTokens ||
      !natural(r.deadlineAtMs) ||
      !Array.isArray(r.messages) ||
      r.messages.length < 1 ||
      r.messages.length > 32 ||
      r.messages.some(
        (m) =>
          Object.keys(m).sort().join() !== "content,role" ||
          !["system", "user", "assistant"].includes(m.role) ||
          typeof m.content !== "string",
      ) ||
      (r.tools !== undefined &&
        (r.tools.length > 8 ||
          new Set(r.tools.map((t) => t.name)).size !== r.tools.length ||
          r.tools.some(
            (t) =>
              Object.keys(t).sort().join() !== "inputSchema,name" ||
              !/^[a-zA-Z0-9_-]{1,64}$/.test(t.name),
          ))) ||
      (mode === "tools" && !r.tools?.length) ||
      (mode === "structured" && (!r.format || !/^[a-zA-Z0-9_-]{1,64}$/.test(r.format.name))) ||
      (mode !== "vision" && r.images !== undefined) ||
      (mode !== "tools" && r.tools !== undefined) ||
      (mode !== "structured" && r.format !== undefined) ||
      (r.format !== undefined && Object.keys(r.format).sort().join() !== "name,schema")
    )
      throw new ProviderError("invalid_request");
    if (
      mode === "vision" &&
      (!r.images?.length ||
        r.images.length > 4 ||
        r.images.some(
          (i) =>
            Object.keys(i).sort().join() !== "base64,mediaType" ||
            !["image/png", "image/jpeg"].includes(i.mediaType) ||
            typeof i.base64 !== "string" ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(i.base64) ||
            i.base64.length > 350_000 ||
            Buffer.from(i.base64, "base64").toString("base64") !== i.base64,
        ))
    )
      throw new ProviderError("invalid_request");
    if (estimateRequest(r) + r.maxOutputTokens > c.contextWindow)
      throw new ProviderError("budget_exceeded");
    return deepFreeze(r);
  } catch (e) {
    throw e instanceof ProviderError ? e : new ProviderError("invalid_request");
  }
}
export const estimateRequest = (r: ModelRequest): number =>
  Buffer.byteLength(JSON.stringify(r)) + 512;
export function estimatePrice(
  c: ProviderCapabilities,
  input: number,
  output: number,
): number | null {
  if (!c.pricing) return null;
  const sum =
    BigInt(input) * BigInt(c.pricing.inputMicrosPerMillionTokens) +
    BigInt(output) * BigInt(c.pricing.outputMicrosPerMillionTokens);
  const value = Number((sum + 999_999n) / 1_000_000n);
  if (!natural(value)) throw new ProviderError("budget_exceeded");
  return value;
}
/** Reservations are charged before every transport attempt, including unknown
 * outcomes. Actual provider usage is a separate observation, never a refund. */
export class ProviderBudget {
  private tokens = 0;
  private micros = 0;
  private calls = 0;
  constructor(readonly limits: { tokens: number; costMicros: number; calls: number }) {
    if (
      !natural(limits.tokens) ||
      !natural(limits.costMicros) ||
      !natural(limits.calls) ||
      limits.calls > 32
    )
      throw new ProviderError("invalid_request");
  }
  reserve(c: ProviderCapabilities, r: ModelRequest): void {
    const tokens = estimateRequest(r) + r.maxOutputTokens,
      cost = estimatePrice(c, estimateRequest(r), r.maxOutputTokens);
    if (
      cost === null ||
      this.tokens + tokens > this.limits.tokens ||
      this.micros + cost > this.limits.costMicros ||
      this.calls >= this.limits.calls
    )
      throw new ProviderError("budget_exceeded");
    this.tokens += tokens;
    this.micros += cost;
    this.calls++;
  }
  snapshot() {
    return { reservedTokens: this.tokens, reservedCostMicros: this.micros, attempts: this.calls };
  }
}
export const requestHash = (mode: ProviderMode, request: ModelRequest): string =>
  contentHash({ mode, request });

/** No implicit live/default selection. Trusted composition supplies the models;
 * only a reviewed configured key is selected. API clients never provide this map. */
export function selectProvider(
  name: string,
  configured: ReadonlyMap<string, LanguageModel>,
): LanguageModel {
  const provider = configured.get(name);
  if (!provider) throw new ProviderError("invalid_request");
  return provider;
}

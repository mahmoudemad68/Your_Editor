import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { randomInt, createHash } from "node:crypto";
import { contentHash, jsonValue } from "@editagent/tool-sdk";
import { deepFreeze } from "./prompts.js";
import {
  ProviderError,
  ProviderBudget,
  checkedCapabilities,
  checkedRequest,
  estimatePrice,
  estimateRequest,
  natural,
  requestHash,
  type LanguageModel,
  type ModelReply,
  type ModelRequest,
  type ModelToolCall,
  type ProviderCapabilities,
  type ProviderMode,
  type ProviderReceipt,
  type ModelUsage,
} from "./provider.js";

export interface ProviderTransportPolicy {
  /** Trusted composition only. Never construct this object from API/model input. */
  readonly endpoint: string;
  readonly allowedOrigins: readonly string[];
  /** Explicit trusted DNS address set. Resolution is pinned to an approved IP. */
  readonly allowedAddresses: readonly string[];
  readonly secret: () => string;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly minIntervalMs: number;
  readonly maxResponseBytes: number;
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ProviderError("invalid_response");
  return v as Record<string, unknown>;
};
const array = (v: unknown): unknown[] => {
  if (!Array.isArray(v) || v.length > 16) throw new ProviderError("invalid_response");
  return v;
};
const text = (v: unknown, maximum = 65536): string => {
  if (typeof v !== "string" || Buffer.byteLength(v) > maximum)
    throw new ProviderError("invalid_response");
  return v;
};
const usageCount = (v: unknown): number => {
  if (!natural(v) || v > 10_000_000) throw new ProviderError("invalid_response");
  return v;
};
const parsedJson = (value: string): unknown => {
  try {
    return jsonValue(JSON.parse(value));
  } catch {
    throw new ProviderError("invalid_response");
  }
};
export abstract class HttpLanguageModel implements LanguageModel {
  readonly capabilities: ProviderCapabilities;
  private readonly endpoint: URL;
  private readonly policy: ProviderTransportPolicy;
  private nextAt = 0;
  protected constructor(
    c: ProviderCapabilities,
    p: ProviderTransportPolicy,
    private readonly budget: ProviderBudget,
  ) {
    this.capabilities = checkedCapabilities(c);
    try {
      const u = new URL(p.endpoint);
      if (
        !p.allowedOrigins.includes(u.origin) ||
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        (u.protocol !== "https:" &&
          !(
            u.protocol === "http:" &&
            c.evidence === "offline_http_fixture" &&
            ["127.0.0.1", "[::1]"].includes(u.hostname)
          )) ||
        !p.allowedAddresses.length ||
        p.allowedAddresses.some((a) => !isIP(a) || /^169\.254\./.test(a)) ||
        !natural(p.timeoutMs) ||
        p.timeoutMs < 1 ||
        p.timeoutMs > 60_000 ||
        !natural(p.maxAttempts) ||
        p.maxAttempts < 1 ||
        p.maxAttempts > 3 ||
        !natural(p.minIntervalMs) ||
        p.minIntervalMs > 60_000 ||
        !natural(p.maxResponseBytes) ||
        p.maxResponseBytes < 64 ||
        p.maxResponseBytes > 1_048_576 ||
        typeof p.secret !== "function"
      )
        throw new Error();
      this.endpoint = u;
      this.policy = Object.freeze({
        ...p,
        allowedOrigins: Object.freeze([...p.allowedOrigins]),
        allowedAddresses: Object.freeze([...p.allowedAddresses]),
      });
    } catch {
      throw new ProviderError("endpoint_denied");
    }
  }
  chat(r: ModelRequest, s: AbortSignal) {
    return this.invoke("chat", r, s);
  }
  tools(r: ModelRequest, s: AbortSignal) {
    return this.invoke("tools", r, s);
  }
  structured(r: ModelRequest, s: AbortSignal) {
    return this.invoke("structured", r, s);
  }
  vision(r: ModelRequest, s: AbortSignal) {
    return this.invoke("vision", r, s);
  }
  protected abstract wire(mode: ProviderMode, r: ModelRequest): unknown;
  protected abstract decode(
    mode: ProviderMode,
    value: unknown,
    request: ModelRequest,
  ): Pick<ModelReply, "text" | "calls" | "structured"> & {
    usage: ModelUsage;
    requestId: string | null;
  };
  protected abstract path(): string;
  protected abstract headers(secret: string): Record<string, string>;
  protected tokenUsage(
    input: unknown,
    output: unknown,
    tokenAccounting: ModelUsage["tokenAccounting"] = "provider_reported_total",
  ): ModelUsage {
    if (input === undefined && output === undefined)
      return {
        source: "unavailable",
        inputTokens: null,
        outputTokens: null,
        actualCostMicros: null,
        tokenAccounting: "unavailable",
      };
    return {
      source:
        this.capabilities.evidence === "offline_http_fixture"
          ? "offline_http_fixture"
          : "provider_reported",
      inputTokens: usageCount(input),
      outputTokens: usageCount(output),
      actualCostMicros: null,
      tokenAccounting,
    };
  }
  private async invoke(
    mode: ProviderMode,
    raw: ModelRequest,
    outer: AbortSignal,
  ): Promise<ModelReply> {
    const r = checkedRequest(this.capabilities, mode, raw),
      started = Date.now();
    if (outer.aborted) throw new ProviderError("cancelled");
    const remaining = Math.min(this.policy.timeoutMs, r.deadlineAtMs - started);
    if (remaining <= 0) throw new ProviderError("timeout");
    const deadline = AbortSignal.timeout(remaining),
      signal = AbortSignal.any([outer, deadline]);
    try {
      const wire = Buffer.from(JSON.stringify(jsonValue(this.wire(mode, r))));
      let attempts = 0;
      while (attempts < this.policy.maxAttempts) {
        const slot = Math.max(Date.now(), this.nextAt);
        this.nextAt = slot + this.policy.minIntervalMs;
        await wait(Math.max(0, slot - Date.now()), signal);
        if (signal.aborted) throw new ProviderError("timeout");
        // Reserve synchronous admission before yielding, including concurrent calls.
        this.budget.reserve(this.capabilities, r);
        attempts++;
        const response = await this.post(wire, signal);
        if (response.status === 429 || response.status === 503) {
          if (attempts === this.policy.maxAttempts)
            throw new ProviderError(response.status === 429 ? "rate_limited" : "unavailable");
          const retry = retryDelay(response.retryAfter, attempts);
          await wait(retry, signal);
          continue;
        }
        if (response.status === 401 || response.status === 403)
          throw new ProviderError("authentication");
        if (response.status < 200 || response.status >= 300)
          throw new ProviderError(response.status >= 500 ? "unavailable" : "invalid_request");
        let value: unknown;
        try {
          value = jsonValue(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)),
          );
        } catch {
          throw new ProviderError("invalid_response");
        }
        let decoded: ReturnType<HttpLanguageModel["decode"]>;
        try {
          decoded = this.decode(mode, value, r);
        } catch (e) {
          throw e instanceof ProviderError ? e : new ProviderError("invalid_response");
        }
        if (
          mode === "tools" &&
          (decoded.calls.length !== 1 || !r.tools!.some((t) => t.name === decoded.calls[0]!.name))
        )
          throw new ProviderError("invalid_response");
        const estimate = estimatePrice(this.capabilities, estimateRequest(r), r.maxOutputTokens);
        const receipt: ProviderReceipt = {
          schemaVersion: "1.0.0",
          provider: this.capabilities.provider,
          modelId: this.capabilities.modelId,
          modelVersion: this.capabilities.modelVersion,
          profileSha256: contentHash(this.capabilities),
          requestSha256: requestHash(mode, r),
          requestIdSha256: decoded.requestId === null ? null : hash(decoded.requestId),
          mode,
          evidence: this.capabilities.evidence,
          usage: decoded.usage,
          estimatedInputTokens: estimateRequest(r),
          estimatedCostMicros: estimate === null ? null : estimate * attempts,
          pricingVersion: this.capabilities.pricing?.version ?? null,
          attempts,
          durationMs: Date.now() - started,
          deadlineAtMs: r.deadlineAtMs,
        };
        return deepFreeze({
          text: decoded.text,
          calls: decoded.calls,
          structured: decoded.structured,
          receipt,
        });
      }
      throw new ProviderError("unavailable");
    } catch (e) {
      if (outer.aborted) throw new ProviderError("cancelled");
      if (deadline.aborted) throw new ProviderError("timeout");
      throw e instanceof ProviderError ? e : new ProviderError("transport_unknown");
    }
  }
  private async post(
    body: Buffer,
    signal: AbortSignal,
  ): Promise<{ status: number; body: Buffer; retryAfter: string | undefined }> {
    const hostname = this.endpoint.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await abortable(lookup(hostname, { all: true }), signal);
    if (
      !addresses.length ||
      addresses.some((a) => !this.policy.allowedAddresses.includes(a.address))
    )
      throw new ProviderError("endpoint_denied");
    const secret = this.policy.secret();
    if (!secret || secret.length > 4096 || /[\r\n]/.test(secret))
      throw new ProviderError("authentication");
    if (signal.aborted) throw new ProviderError("cancelled");
    return new Promise((resolve, reject) => {
      const send = this.endpoint.protocol === "https:" ? httpsRequest : httpRequest;
      const req = send(
        {
          protocol: this.endpoint.protocol,
          hostname: addresses[0]!.address,
          port: this.endpoint.port || undefined,
          servername: hostname,
          path: this.endpoint.pathname.replace(/\/$/, "") + this.path(),
          method: "POST",
          agent: false,
          headers: {
            host: this.endpoint.host,
            "content-type": "application/json",
            "content-length": String(body.length),
            ...this.headers(secret),
          },
          signal,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let length = 0;
          res.on("data", (chunk: Buffer) => {
            length += chunk.length;
            if (length > this.policy.maxResponseBytes) {
              req.destroy();
              reject(new ProviderError("invalid_response"));
            } else chunks.push(chunk);
          });
          res.on("error", () => reject(new ProviderError("transport_unknown")));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks),
              retryAfter:
                typeof res.headers["retry-after"] === "string"
                  ? res.headers["retry-after"]
                  : undefined,
            }),
          );
        },
      );
      req.on("error", () => reject(new ProviderError("transport_unknown")));
      req.end(body);
    });
  }
}
function retryDelay(header: string | undefined, attempt: number): number {
  if (header !== undefined) {
    const milliseconds = /^\d+(\.\d+)?$/.test(header)
      ? Number(header) * 1000
      : Date.parse(header) - Date.now();
    // Never violate a long Retry-After to squeeze another attempt into budget.
    if (!Number.isFinite(milliseconds) || milliseconds > 60_000)
      throw new ProviderError("rate_limited");
    return Math.max(0, Math.ceil(milliseconds));
  }
  return Math.min(2000, 100 * 2 ** (attempt - 1)) + randomInt(0, 101);
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new ProviderError("cancelled"));
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", stop))
      .catch(() => undefined);
  });
}
async function wait(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(new ProviderError("cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
}

export class OpenAICompatibleProvider extends HttpLanguageModel {
  constructor(c: ProviderCapabilities, p: ProviderTransportPolicy, b: ProviderBudget) {
    super(c, p, b);
    if (c.provider !== "openai-compatible") throw new ProviderError("invalid_request");
  }
  protected path() {
    return "/chat/completions";
  }
  protected headers(secret: string) {
    return { authorization: `Bearer ${secret}` };
  }
  protected wire(mode: ProviderMode, r: ModelRequest) {
    const messages = r.messages.map((m, i) =>
      mode === "vision" && i === r.messages.length - 1
        ? {
            role: m.role,
            content: [
              { type: "text", text: m.content },
              ...r.images!.map((image) => ({
                type: "image_url",
                image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
              })),
            ],
          }
        : m,
    );
    return {
      model: this.capabilities.modelId,
      messages,
      max_completion_tokens: r.maxOutputTokens,
      n: 1,
      ...(mode === "tools"
        ? {
            tools: r.tools!.map((t) => ({
              type: "function",
              function: { name: t.name, parameters: t.inputSchema, strict: true },
            })),
            tool_choice: "required",
            parallel_tool_calls: false,
          }
        : {}),
      ...(mode === "structured"
        ? {
            response_format: {
              type: "json_schema",
              json_schema: { name: r.format!.name, schema: r.format!.schema, strict: true },
            },
          }
        : {}),
    };
  }
  protected decode(mode: ProviderMode, value: unknown, _request: ModelRequest) {
    const data = object(value),
      choices = array(data.choices);
    if (choices.length !== 1 || data.model !== this.capabilities.modelId)
      throw new ProviderError("invalid_response");
    const choice = object(choices[0]),
      message = object(choice.message);
    if (message.refusal || choice.finish_reason === "content_filter")
      throw new ProviderError("refused");
    if (choice.finish_reason === "length") throw new ProviderError("truncated");
    if (!["stop", "tool_calls"].includes(String(choice.finish_reason)))
      throw new ProviderError("invalid_response");
    const calls: ModelToolCall[] =
      message.tool_calls === undefined
        ? []
        : array(message.tool_calls).map((raw) => {
            const call = object(raw),
              fn = object(call.function);
            if (call.type !== "function") throw new ProviderError("invalid_response");
            return {
              idSha256: hash(text(call.id, 128)),
              name: text(fn.name, 64),
              arguments: parsedJson(text(fn.arguments)),
            };
          });
    if (mode === "tools" && (!calls.length || choice.finish_reason !== "tool_calls"))
      throw new ProviderError("invalid_response");
    if (mode !== "tools" && calls.length) throw new ProviderError("invalid_response");
    const content =
      message.content === null || message.content === undefined ? null : text(message.content);
    const u = data.usage === undefined ? {} : object(data.usage);
    return {
      text: mode === "structured" ? null : content,
      calls,
      structured: mode === "structured" ? parsedJson(text(content)) : null,
      usage: this.tokenUsage(u.prompt_tokens, u.completion_tokens),
      requestId: data.id === undefined ? null : text(data.id, 128),
    };
  }
}
export class AnthropicProvider extends HttpLanguageModel {
  constructor(c: ProviderCapabilities, p: ProviderTransportPolicy, b: ProviderBudget) {
    super(c, p, b);
    if (c.provider !== "anthropic") throw new ProviderError("invalid_request");
  }
  protected path() {
    return "/messages";
  }
  protected headers(secret: string) {
    return { "x-api-key": secret, "anthropic-version": "2023-06-01" };
  }
  protected wire(mode: ProviderMode, r: ModelRequest) {
    const systems = r.messages.filter((m) => m.role === "system").map((m) => m.content);
    const messages = r.messages
      .filter((m) => m.role !== "system")
      .map((m, i, list) => ({
        role: m.role,
        content: [
          { type: "text", text: m.content },
          ...(mode === "vision" && i === list.length - 1
            ? r.images!.map((image) => ({
                type: "image",
                source: { type: "base64", media_type: image.mediaType, data: image.base64 },
              }))
            : []),
        ],
      }));
    return {
      model: this.capabilities.modelId,
      max_tokens: r.maxOutputTokens,
      system: systems.join("\n"),
      messages,
      ...(mode === "tools"
        ? {
            tools: r.tools!.map((t) => ({ name: t.name, input_schema: t.inputSchema })),
            tool_choice: { type: "any", disable_parallel_tool_use: true },
          }
        : {}),
      ...(mode === "structured"
        ? {
            tools: [{ name: r.format!.name, input_schema: r.format!.schema }],
            tool_choice: { type: "tool", name: r.format!.name, disable_parallel_tool_use: true },
          }
        : {}),
    };
  }
  protected decode(mode: ProviderMode, value: unknown, request: ModelRequest) {
    const data = object(value);
    if (
      data.type !== "message" ||
      data.role !== "assistant" ||
      data.model !== this.capabilities.modelId
    )
      throw new ProviderError("invalid_response");
    if (data.stop_reason === "refusal") throw new ProviderError("refused");
    if (["max_tokens", "model_context_window_exceeded"].includes(String(data.stop_reason)))
      throw new ProviderError("truncated");
    if (!["end_turn", "tool_use"].includes(String(data.stop_reason)))
      throw new ProviderError("invalid_response");
    const texts: string[] = [],
      calls: ModelToolCall[] = [];
    for (const raw of array(data.content)) {
      const block = object(raw);
      if (block.type === "text") texts.push(text(block.text));
      else if (block.type === "tool_use")
        calls.push({
          idSha256: hash(text(block.id, 128)),
          name: text(block.name, 64),
          arguments: jsonValue(block.input),
        });
      else throw new ProviderError("unsupported_mode");
    }
    if (
      (mode === "tools" || mode === "structured") &&
      (!calls.length || data.stop_reason !== "tool_use")
    )
      throw new ProviderError("invalid_response");
    if (mode !== "tools" && mode !== "structured" && calls.length)
      throw new ProviderError("invalid_response");
    if (mode === "structured" && (calls.length !== 1 || calls[0]!.name !== request.format!.name))
      throw new ProviderError("invalid_response");
    const u = data.usage === undefined ? {} : object(data.usage);
    const input =
      u.input_tokens === undefined
        ? undefined
        : usageCount(u.input_tokens) +
          usageCount(u.cache_read_input_tokens ?? 0) +
          usageCount(u.cache_creation_input_tokens ?? 0);
    return {
      text: mode === "structured" ? null : texts.join(""),
      calls: mode === "structured" ? [] : calls,
      structured: mode === "structured" ? calls[0]!.arguments : null,
      usage: this.tokenUsage(input, u.output_tokens, "native_input_and_cache_sum"),
      requestId: data.id === undefined ? null : text(data.id, 128),
    };
  }
}
export function configuredHttpProvider(
  configuration: { capabilities: ProviderCapabilities; transport: ProviderTransportPolicy },
  budget: ProviderBudget,
): LanguageModel {
  if (configuration.capabilities.provider === "openai-compatible")
    return new OpenAICompatibleProvider(
      configuration.capabilities,
      configuration.transport,
      budget,
    );
  if (configuration.capabilities.provider === "anthropic")
    return new AnthropicProvider(configuration.capabilities, configuration.transport, budget);
  throw new ProviderError("invalid_request");
}

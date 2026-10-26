import { contentHash, jsonValue } from "@editagent/tool-sdk";
import { deepFreeze } from "./prompts.js";
import {
  ProviderError,
  checkedCapabilities,
  checkedRequest,
  estimatePrice,
  estimateRequest,
  requestHash,
  natural,
  type ProviderCapabilities,
  type LanguageModel,
  type ModelReply,
  type ModelRequest,
  type ProviderMode,
  type ModelToolCall,
  type ProviderReceipt,
} from "./provider.js";

export interface ReplayEntry {
  readonly mode: ProviderMode;
  readonly requestSha256: string;
  readonly reply: {
    readonly text: string | null;
    readonly calls: readonly ModelToolCall[];
    readonly structured: unknown;
  };
  readonly syntheticUsage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
  };
}
/** Cassettes are supplied explicitly by isolated qualification; recording never
 * writes prompts/provider bodies to logs/files. Sanitized caller-owned cassette
 * data are hashed and immutable. No production composition imports this driver. */
export class ReplayProvider implements LanguageModel {
  readonly capabilities: ProviderCapabilities;
  private readonly entries: readonly ReplayEntry[];
  private cursor = 0;
  constructor(c: ProviderCapabilities, entries: readonly ReplayEntry[]) {
    this.capabilities = checkedCapabilities(c);
    if (c.provider !== "replay" || entries.length > 16) throw new ProviderError("invalid_request");
    try {
      const safe = jsonValue(entries) as unknown as ReplayEntry[];
      if (
        safe.some(
          (e) =>
            !["chat", "tools", "structured", "vision"].includes(e.mode) ||
            !/^[a-f0-9]{64}$/.test(e.requestSha256) ||
            (e.reply.text !== null && typeof e.reply.text !== "string") ||
            !Array.isArray(e.reply.calls) ||
            e.reply.calls.length > 8 ||
            e.reply.calls.some(
              (c) => !/^[a-f0-9]{64}$/.test(c.idSha256) || !/^[a-zA-Z0-9_-]{1,64}$/.test(c.name),
            ) ||
            [e.syntheticUsage.inputTokens, e.syntheticUsage.outputTokens].some(
              (n) => n !== null && (!natural(n) || n > 10000000),
            ),
        )
      )
        throw new Error();
      this.entries = deepFreeze(safe);
    } catch {
      throw new ProviderError("invalid_request");
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
  private async invoke(
    mode: ProviderMode,
    raw: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelReply> {
    if (signal.aborted) throw new ProviderError("cancelled");
    const r = checkedRequest(this.capabilities, mode, raw);
    if (Date.now() >= r.deadlineAtMs) throw new ProviderError("timeout");
    const entry = this.entries[this.cursor];
    if (!entry || entry.mode !== mode || entry.requestSha256 !== requestHash(mode, r))
      throw new ProviderError("invalid_request");
    this.cursor++;
    const receipt: ProviderReceipt = {
      schemaVersion: "1.0.0",
      provider: "replay",
      modelId: this.capabilities.modelId,
      modelVersion: this.capabilities.modelVersion,
      profileSha256: contentHash(this.capabilities),
      configurationVersion: this.capabilities.configurationVersion,
      requestSha256: entry.requestSha256,
      requestIdSha256: null,
      mode,
      evidence: "synthetic_replay",
      usage: {
        source: "synthetic_replay",
        ...entry.syntheticUsage,
        actualCostMicros: null,
        tokenAccounting: "synthetic_replay",
      },
      estimatedInputTokens: estimateRequest(r),
      estimatedCostMicros: estimatePrice(this.capabilities, estimateRequest(r), r.maxOutputTokens),
      pricingVersion: this.capabilities.pricing?.version ?? null,
      attempts: 1,
      durationMs: 0,
      deadlineAtMs: r.deadlineAtMs,
    };
    return deepFreeze({ ...entry.reply, receipt });
  }
}
export function recordReplayEntry(
  mode: ProviderMode,
  request: ModelRequest,
  reply: ModelReply,
): ReplayEntry {
  if (
    reply.receipt.evidence !== "synthetic_replay" &&
    reply.receipt.evidence !== "offline_http_fixture"
  )
    throw new ProviderError("invalid_request");
  return deepFreeze({
    mode,
    requestSha256: requestHash(mode, request),
    reply: jsonValue({
      text: reply.text,
      calls: reply.calls,
      structured: reply.structured,
    }) as ReplayEntry["reply"],
    syntheticUsage: {
      inputTokens: reply.receipt.usage.inputTokens,
      outputTokens: reply.receipt.usage.outputTokens,
    },
  });
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { contentHash } from "@editagent/tool-sdk";
import {
  OpenAICompatibleProvider,
  AnthropicProvider,
  type ProviderTransportPolicy,
} from "./provider-http.js";
import { ReplayProvider, recordReplayEntry } from "./provider-replay.js";
import {
  ProviderBudget,
  ProviderError,
  checkedCapabilities,
  selectProvider,
  requestHash,
  type LanguageModel,
  type ModelRequest,
  type ProviderCapabilities,
  type ProviderMode,
  type ModelReply,
} from "./provider.js";

const caps = (provider: ProviderCapabilities["provider"]): ProviderCapabilities => ({
  schemaVersion: "1.0.0",
  provider,
  modelId: "qualification-model",
  modelVersion: "offline-1",
  contextWindow: 65536,
  maxOutputTokens: 4096,
  modes: ["chat", "tools", "structured", "vision"],
  tokenizer: { kind: "conservative_utf8_bytes", version: "1" },
  evidence: provider === "replay" ? "synthetic_replay" : "offline_http_fixture",
  configurationVersion: "test-1",
  pricing: {
    version: "synthetic-1",
    provenance: "synthetic_fixture",
    inputMicrosPerMillionTokens: 1000,
    outputMicrosPerMillionTokens: 2000,
  },
});
const shape = {
  type: "object",
  additionalProperties: false,
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
};
const request = (mode: ProviderMode, deadline = Date.now() + 30_000): ModelRequest => ({
  messages: [
    { role: "system", content: "offline conformance" },
    { role: "user", content: "English والعربية" },
  ],
  maxOutputTokens: 128,
  deadlineAtMs: deadline,
  ...(mode === "tools" ? { tools: [{ name: "trim_video", inputSchema: shape }] } : {}),
  ...(mode === "structured" ? { format: { name: "test_result", schema: shape } } : {}),
  ...(mode === "vision"
    ? {
        images: [
          {
            mediaType: "image/png" as const,
            base64: Buffer.from("offline-image-shape").toString("base64"),
          },
        ],
      }
    : {}),
});
const budget = () => new ProviderBudget({ tokens: 100_000, costMicros: 100_000, calls: 16 });
async function server(
  handler: (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void,
): Promise<{ http: Server; endpoint: string }> {
  const http = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        handler(req, res, JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
      } catch {
        res.writeHead(500);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert(address && typeof address !== "string");
  return { http, endpoint: `http://127.0.0.1:${address.port}/v1` };
}
async function close(http: Server) {
  http.closeAllConnections();
  await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
}
const policy = (endpoint: string): ProviderTransportPolicy => ({
  endpoint,
  allowedOrigins: [new URL(endpoint).origin],
  allowedAddresses: ["127.0.0.1"],
  secret: () => randomBytes(20).toString("hex"),
  timeoutMs: 2000,
  maxAttempts: 3,
  minIntervalMs: 0,
  maxResponseBytes: 65536,
});
function fixture(provider: "openai-compatible" | "anthropic", mode: ProviderMode) {
  if (provider === "openai-compatible")
    return {
      id: "offline-response",
      model: "qualification-model",
      usage: { prompt_tokens: 10, completion_tokens: 20 },
      choices: [
        {
          finish_reason: mode === "tools" ? "tool_calls" : "stop",
          message: {
            content:
              mode === "structured" ? '{"ok":true}' : mode === "tools" ? null : "English والعربية",
            ...(mode === "tools"
              ? {
                  tool_calls: [
                    {
                      id: "offline-call",
                      type: "function",
                      function: { name: "trim_video", arguments: '{"ok":true}' },
                    },
                  ],
                }
              : {}),
          },
        },
      ],
    };
  return {
    id: "offline-response",
    type: "message",
    model: "qualification-model",
    role: "assistant",
    usage: { input_tokens: 10, output_tokens: 20 },
    stop_reason: mode === "tools" || mode === "structured" ? "tool_use" : "end_turn",
    content:
      mode === "tools" || mode === "structured"
        ? [
            {
              type: "tool_use",
              id: "offline-call",
              name: mode === "tools" ? "trim_video" : "test_result",
              input: { ok: true },
            },
          ]
        : [{ type: "text", text: "English والعربية" }],
  };
}
for (const provider of ["openai-compatible", "anthropic", "replay"] as const) {
  test(`US301 shared supported-mode conformance: ${provider} (offline only)`, async () => {
    const requests = (["chat", "tools", "structured", "vision"] as const).map((mode) => ({
      mode,
      r: request(mode),
    }));
    const wireModes: ProviderMode[] = [];
    let hosted: Awaited<ReturnType<typeof server>> | undefined;
    let model: LanguageModel;
    if (provider === "replay") {
      model = new ReplayProvider(
        caps(provider),
        requests.map(({ mode, r }) => ({
          mode,
          requestSha256: requestHash(mode, r),
          reply: {
            text: mode === "chat" || mode === "vision" ? "English والعربية" : null,
            calls:
              mode === "tools"
                ? [
                    {
                      idSha256: contentHash("offline-call"),
                      name: "trim_video",
                      arguments: { ok: true },
                    },
                  ]
                : [],
            structured: mode === "structured" ? { ok: true } : null,
          },
          syntheticUsage: { inputTokens: 10, outputTokens: 20 },
        })),
      );
    } else {
      hosted = await server((req, res, body) => {
        assert.equal(req.method, "POST");
        assert.equal(body.model, "qualification-model");
        const isAnthropic = provider === "anthropic";
        assert.equal(req.url, isAnthropic ? "/v1/messages" : "/v1/chat/completions");
        assert.equal(typeof req.headers[isAnthropic ? "x-api-key" : "authorization"], "string");
        const mode = requests[wireModes.length]!.mode;
        if (mode === "tools" || mode === "structured")
          assert(Array.isArray(body.tools) || !!body.response_format);
        if (mode === "vision")
          assert(JSON.stringify(body).includes(isAnthropic ? '"base64"' : '"image_url"'));
        if (isAnthropic) {
          assert.equal(req.headers["anthropic-version"], "2023-06-01");
          assert.equal(body.max_tokens, 128);
        } else assert.equal(body.max_completion_tokens, 128);
        wireModes.push(mode);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(fixture(provider, mode)));
      });
      model =
        provider === "anthropic"
          ? new AnthropicProvider(caps(provider), policy(hosted.endpoint), budget())
          : new OpenAICompatibleProvider(caps(provider), policy(hosted.endpoint), budget());
    }
    try {
      for (const { mode, r } of requests) {
        const reply = await model[mode](r, new AbortController().signal);
        assert.equal(reply.receipt.modelId, "qualification-model");
        assert.equal(reply.receipt.configurationVersion, caps(provider).configurationVersion);
        assert.equal(reply.receipt.transportProfileSha256 === null, provider === "replay");
        assert.equal(reply.receipt.requestSha256, requestHash(mode, r));
        assert.equal(reply.receipt.usage.actualCostMicros, null);
        assert.equal(reply.receipt.usage.inputTokens, 10);
        assert.equal(reply.receipt.usage.outputTokens, 20);
        assert.equal(
          reply.receipt.usage.source,
          provider === "replay" ? "synthetic_replay" : "offline_http_fixture",
        );
        assert.equal(reply.receipt.evidence, caps(provider).evidence);
        assert.equal(Object.isFrozen(reply), true);
        if (mode === "tools") assert.equal(reply.calls[0]?.name, "trim_video");
        if (mode === "structured") assert.equal((reply.structured as { ok: boolean }).ok, true);
        if (mode === "chat" || mode === "vision") assert.equal(reply.text, "English والعربية");
        assert.equal(selectProvider("configured", new Map([["configured", model]])), model);
        const entry = recordReplayEntry(mode, r, reply);
        const repeat = new ReplayProvider(caps("replay"), [entry]);
        assert.deepEqual(
          (await repeat[mode](r, new AbortController().signal)).structured,
          reply.structured,
        );
      }
      if (provider !== "replay") assert.equal(wireModes.length, 4);
    } finally {
      if (hosted) await close(hosted.http);
    }
  });
}
test("provider transport: 429/503 retries reserve every attempt; auth/500/redirect/unknown errors do not replay", async () => {
  for (const status of [429, 503, 401, 403, 500, 302]) {
    let attempts = 0;
    const hosted = await server((_req, res) => {
      attempts++;
      if (attempts === 1) {
        res.writeHead(status, { "retry-after": "0", location: "http://169.254.169.254/" });
        res.end();
      } else res.end(JSON.stringify(fixture("openai-compatible", "chat")));
    });
    try {
      const b = budget(),
        model = new OpenAICompatibleProvider(caps("openai-compatible"), policy(hosted.endpoint), b);
      if (status === 429 || status === 503) {
        const result = await model.chat(request("chat"), new AbortController().signal);
        assert.equal(result.receipt.attempts, 2);
        assert.equal(b.snapshot().attempts, 2);
      } else {
        await assert.rejects(
          model.chat(request("chat"), new AbortController().signal),
          ProviderError,
        );
        assert.equal(attempts, 1);
      }
    } finally {
      await close(hosted.http);
    }
  }
});
test("provider timeout, cancellation, rate limiting, response bytes and credentials stay bounded", async () => {
  for (const mode of [
    "timeout",
    "cancel",
    "oversize",
    "malformed",
    "truncated",
    "refused",
    "missing-usage",
  ] as const) {
    let attempts = 0;
    const hosted = await server((_req, res) => {
      attempts++;
      if (mode === "timeout" || mode === "cancel") return;
      if (mode === "oversize") {
        res.end("x".repeat(70000));
        return;
      }
      if (mode === "malformed") {
        res.end(Buffer.from([0xc3, 0x28]));
        return;
      }
      const data = fixture("openai-compatible", "chat");
      if (mode === "missing-usage") delete (data as { usage?: unknown }).usage;
      if (mode === "truncated") data.choices![0]!.finish_reason = "length";
      if (mode === "refused") data.choices![0]!.finish_reason = "content_filter";
      res.end(JSON.stringify(data));
    });
    try {
      const stop = new AbortController(),
        model = new OpenAICompatibleProvider(
          caps("openai-compatible"),
          { ...policy(hosted.endpoint), timeoutMs: 100 },
          budget(),
        );
      const timer = mode === "cancel" ? setTimeout(() => stop.abort(), 30) : null;
      try {
        if (mode === "missing-usage") {
          const reply = await model.chat(request("chat"), stop.signal);
          assert.equal(reply.receipt.usage.source, "unavailable");
          assert.equal(reply.receipt.usage.inputTokens, null);
        } else
          await assert.rejects(
            model.chat(request("chat"), stop.signal),
            (e: unknown) =>
              e instanceof ProviderError && e.message === e.code && !e.stack?.includes("node:"),
          );
        assert.equal(attempts, 1);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } finally {
      await close(hosted.http);
    }
  }
});
test("provider configuration, request scopes and token/cost budgets fail closed before HTTP", async () => {
  const c = caps("openai-compatible"),
    p = policy("http://127.0.0.1:1/v1");
  for (const endpoint of [
    "http://169.254.169.254/v1",
    "https://example.com/v1",
    "http://user:pass@127.0.0.1:1/v1",
    "http://127.0.0.1:1/v1?key=private",
  ]) {
    assert.throws(
      () => new OpenAICompatibleProvider(c, { ...p, endpoint }, budget()),
      ProviderError,
    );
  }
  assert.throws(() => checkedCapabilities({ ...c, modes: ["chat", "chat"] }), ProviderError);
  const noVision = new OpenAICompatibleProvider({ ...c, modes: ["chat"] }, p, budget());
  await assert.rejects(
    noVision.vision(request("vision"), new AbortController().signal),
    (e: unknown) => e instanceof ProviderError && e.code === "unsupported_mode",
  );
  const unknown = { ...request("chat"), endpoint: "http://169.254.169.254" };
  await assert.rejects(noVision.chat(unknown, new AbortController().signal), ProviderError);
  const b = new ProviderBudget({ tokens: 1, costMicros: 0, calls: 1 });
  await assert.rejects(
    new OpenAICompatibleProvider(c, p, b).chat(request("chat"), new AbortController().signal),
    (e: unknown) => e instanceof ProviderError && e.code === "budget_exceeded",
  );
  const noPrice = new OpenAICompatibleProvider({ ...c, pricing: null }, p, budget());
  await assert.rejects(
    noPrice.chat(request("chat"), new AbortController().signal),
    (e: unknown) => e instanceof ProviderError && e.code === "budget_exceeded",
  );
});
test("replay output is exact across fresh providers and rejects unmatched requests without exposing content", async () => {
  const c = caps("replay"),
    r = request("structured"),
    entry = {
      mode: "structured" as const,
      requestSha256: requestHash("structured", r),
      reply: { text: null, calls: [], structured: { ok: true } },
      syntheticUsage: { inputTokens: 1, outputTokens: 2 },
    };
  const outputs: ModelReply[] = [];
  for (let i = 0; i < 3; i++)
    outputs.push(await new ReplayProvider(c, [entry]).structured(r, new AbortController().signal));
  assert.deepEqual(outputs[0], outputs[1]);
  assert.deepEqual(outputs[1], outputs[2]);
  await assert.rejects(
    new ReplayProvider(c, [entry]).structured(
      { ...r, maxOutputTokens: 129 },
      new AbortController().signal,
    ),
    ProviderError,
  );
});

test("native cache usage is counted, concurrent calls share rate admission, unknown sockets never retry", async () => {
  const arrivals: number[] = [];
  const hosted = await server((_req, res) => {
    arrivals.push(performance.now());
    res.end(
      JSON.stringify({
        ...fixture("anthropic", "chat"),
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 40,
        },
      }),
    );
  });
  try {
    const model = new AnthropicProvider(
      caps("anthropic"),
      { ...policy(hosted.endpoint), minIntervalMs: 80 },
      budget(),
    );
    const replies = await Promise.all(
      [1, 2, 3].map(() => model.chat(request("chat"), new AbortController().signal)),
    );
    for (const reply of replies) {
      assert.equal(reply.receipt.usage.inputTokens, 80);
      assert.equal(reply.receipt.usage.tokenAccounting, "native_input_and_cache_sum");
    }
    assert.equal(arrivals.length, 3);
    assert(arrivals[2]! - arrivals[0]! >= 100, "shared admission must space concurrent dispatches");
  } finally {
    await close(hosted.http);
  }
  let attempts = 0;
  const broken = await server((req) => {
    attempts++;
    req.socket.destroy();
  });
  try {
    const model = new OpenAICompatibleProvider(
      caps("openai-compatible"),
      policy(broken.endpoint),
      budget(),
    );
    await assert.rejects(
      model.chat(request("chat"), new AbortController().signal),
      (e: unknown) => e instanceof ProviderError && e.code === "transport_unknown",
    );
    assert.equal(attempts, 1);
  } finally {
    await close(broken.http);
  }
});

test("trusted configuration selects the compatible output cap and records its distinct transport profile", async () => {
  let field: "max_tokens" | "max_completion_tokens" = "max_completion_tokens",
    observed = 0;
  const hosted = await server((_req, res, body) => {
    assert.equal(body[field], 128);
    assert.equal(
      Object.hasOwn(body, field === "max_tokens" ? "max_completion_tokens" : "max_tokens"),
      false,
    );
    observed++;
    res.end(JSON.stringify(fixture("openai-compatible", "chat")));
  });
  try {
    const c = caps("openai-compatible"),
      p = policy(hosted.endpoint),
      r = request("chat"),
      hashes: string[] = [];
    for (const selectedField of ["max_completion_tokens", "max_tokens"] as const) {
      field = selectedField;
      const model = new OpenAICompatibleProvider(
        c,
        { ...p, openAiOutputLimitField: field },
        budget(),
      );
      const reply = await model.chat(r, new AbortController().signal);
      assert.equal(reply.receipt.requestSha256, requestHash("chat", r));
      assert.match(reply.receipt.transportProfileSha256!, /^[a-f0-9]{64}$/);
      hashes.push(reply.receipt.transportProfileSha256!);
    }
    assert.equal(observed, 2);
    assert.notEqual(hashes[0], hashes[1]);
    assert.throws(
      () =>
        new OpenAICompatibleProvider(
          c,
          { ...p, openAiOutputLimitField: "uncapped" as "max_tokens" },
          budget(),
        ),
      ProviderError,
    );
  } finally {
    await close(hosted.http);
  }
});

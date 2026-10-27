// PR #88 Independent QA, part P: US-301 provider ports against QA-owned local fake HTTP/TLS servers (no hosted
// endpoint, no real credential). Runs unchanged on the host build and inside the packaged agent-worker image.
// Usage: QA88_RESOLVE_FROM=<package.json> QA88_PREFIX=PH|PI [QA88_TLS=<dir>] node prov88.mjs
// Prints one line "QA88_RESULTS <json>". Only codes, counts, booleans and hashes are reported (no bodies/secrets).
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { inspect } from "node:util";
import path from "node:path";

const req0 = createRequire(process.env.QA88_RESOLVE_FROM);
const AC = req0("@editagent/agent-core");
const { contentHash } = req0("@editagent/tool-sdk");
const PREFIX = process.env.QA88_PREFIX ?? "PH", TLS = process.env.QA88_TLS ?? "";
// The adapters canonicalize JSON (sorted keys) before sending; compare structure, not key insertion order.
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const NATIVE_SUM = ["native", "input", "and", "cache", "sum"].join("_");
const sha = (s) => createHash("sha256").update(s).digest("hex");
// Runtime-generated fixture credential: never a committed literal, never a real key.
const SECRET = ["qa88", "fixture", randomBytes(12).toString("hex")].join("-");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const leakSink = [];
const results = [];
let n = 0;
async function probe(title, expected, fn) {
  const id = `${PREFIX}${String(++n).padStart(2, "0")}`, start = Date.now();
  try {
    const r = await fn();
    results.push({ id, title, status: r.pass ? "PASS" : "FAIL", expected, actual: r.actual, ms: Date.now() - start, mode: PREFIX === "PI" ? "packaged-image-offline" : "host-offline" });
  } catch (e) {
    results.push({ id, title, status: "ERROR", expected, actual: String(e?.stack ?? e).replaceAll(SECRET, "[secret]").slice(0, 600), ms: Date.now() - start, mode: PREFIX });
  }
  console.error(`[QA88] ${id} ${results.at(-1).status} ${title}`);
}
/** Captures the typed outcome and every serialization of a failure for the leak check. */
async function outcome(fn) {
  try { const r = await fn(); leakSink.push(JSON.stringify(r)); return { ok: true, r }; }
  catch (e) { leakSink.push(String(e), String(e?.stack), JSON.stringify(e), inspect(e, { depth: 5 })); return { ok: false, code: e?.code ?? e?.name ?? "unknown" }; }
}
const code = (o) => (o.ok ? "OK" : o.code);

/** QA fake provider server. handler(rec, res) decides the reply; rec captures method/path/headers/body. */
function fake(handler, { tls = null, dual = false } = {}) {
  const requests = [], sockets = { connections: 0, tlsErrors: 0 };
  const onReq = (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks), rec = { at: Date.now(), method: req.method, path: req.url, headers: { ...req.headers }, raw, remote: req.socket.remoteAddress };
      try { rec.body = JSON.parse(raw.toString("utf8")); } catch { rec.body = null; }
      requests.push(rec);
      handler(rec, res, requests.length);
    });
  };
  const server = tls ? https.createServer({ key: tls.key, cert: tls.cert }, onReq) : http.createServer(onReq);
  server.on("connection", () => sockets.connections++);
  server.on("tlsClientError", () => sockets.tlsErrors++);
  // dual: listen on all loopback families, because a resolved "localhost" may be ::1 first (the adapter pins addresses[0]).
  const listen = (host, retry) => new Promise((ok) => { server.once("error", () => (retry ? listen(retry, null).then(ok) : ok())); server.listen(0, host, ok); });
  return listen(dual ? "::" : "127.0.0.1", dual ? "127.0.0.1" : null).then(() => new Promise((resolve) => {
    const port = server.address().port;
    resolve({ port, origin: `${tls ? "https" : "http"}://127.0.0.1:${port}`, requests, sockets, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) });
  }));
}
const json = (res, status, body, headers = {}) => { const b = Buffer.from(typeof body === "string" ? body : JSON.stringify(body)); res.writeHead(status, { "content-type": "application/json", "content-length": b.length, ...headers }); res.end(b); };

const MODEL = { "openai-compatible": "qa-oa-fixture-model", anthropic: "qa-an-fixture-model" };
const caps = (provider, over = {}) => ({
  schemaVersion: "1.0.0", provider, modelId: MODEL[provider] ?? "qa-replay-model", modelVersion: "2026-10-qa", contextWindow: 32768, maxOutputTokens: 1024,
  modes: ["chat", "tools", "structured", "vision"], tokenizer: { kind: "conservative_utf8_bytes", version: "1" },
  evidence: provider === "replay" ? "synthetic_replay" : "offline_http_fixture", configurationVersion: "qa88-cfg-1",
  pricing: { version: "qa88-price-1", provenance: "synthetic_fixture", inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 2000 }, ...over,
});
const policy = (endpoint, over = {}) => ({ endpoint, allowedOrigins: [new URL(endpoint).origin], allowedAddresses: ["127.0.0.1"], secret: () => SECRET, timeoutMs: 5000, maxAttempts: 3, minIntervalMs: 0, maxResponseBytes: 65536, ...over });
const budget = (over = {}) => new AC.ProviderBudget({ tokens: 10_000_000, costMicros: 10_000_000, calls: 32, ...over });
const OA = (srv, pOver = {}, cOver = {}, b = budget()) => new AC.OpenAICompatibleProvider(caps("openai-compatible", cOver), policy(`${srv.origin}/v1`, pOver), b);
const AN = (srv, pOver = {}, cOver = {}, b = budget()) => new AC.AnthropicProvider(caps("anthropic", cOver), policy(`${srv.origin}/v1`, pOver), b);
const TOOL = { name: "qa_tool", inputSchema: { type: "object", properties: { x: { type: "integer" } }, required: ["x"], additionalProperties: false } };
const FORMAT = { name: "qa_format", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } };
const request = (mode, over = {}) => ({
  messages: [{ role: "system", content: "QA system instruction" }, { role: "user", content: "QA user data عربي English" }], maxOutputTokens: 256, deadlineAtMs: Date.now() + 10_000,
  ...(mode === "tools" ? { tools: [TOOL] } : {}), ...(mode === "structured" ? { format: FORMAT } : {}), ...(mode === "vision" ? { images: [{ mediaType: "image/png", base64: PNG }] } : {}), ...over,
});
const oaBody = ({ content = "qa reply", finish = "stop", calls, usage = { prompt_tokens: 11, completion_tokens: 7 }, id = "chatcmpl-qa88", model = MODEL["openai-compatible"], refusal, choices } = {}) => ({
  id, object: "chat.completion", model, ...(usage === null ? {} : { usage }),
  choices: choices ?? [{ index: 0, finish_reason: finish, message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}), ...(refusal ? { refusal } : {}) } }],
});
const anBody = ({ content = [{ type: "text", text: "qa reply" }], stop = "end_turn", usage = { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 }, id = "msg_qa88", model = MODEL.anthropic, type = "message", role = "assistant" } = {}) => ({
  id, type, role, model, content, stop_reason: stop, ...(usage === null ? {} : { usage }),
});
const sortedKeys = (o) => Object.keys(o ?? {}).sort().join(",");
const ac = () => new AbortController().signal;

// ---------------- Wire serialization + decode (both distinct protocols, all four supported modes) -------------
await probe("OpenAI-compatible chat: exact POST path/headers/body dialect, decode and receipt provenance", "POST /v1/chat/completions; Bearer only; body {model,messages,max_completion_tokens,n}; never max_tokens; receipt usage offline_http_fixture 11/7, cost null, hashes bound", async () => {
  const s = await fake((r, res) => json(res, 200, oaBody()));
  const c = caps("openai-compatible"), rq = request("chat"), p = OA(s);
  const o = await outcome(() => p.chat(rq, ac()));
  await s.close();
  const h = s.requests[0]?.headers ?? {}, b = s.requests[0]?.body ?? {}, rc = o.r?.receipt;
  const est = AC.estimateRequest(rq), price = AC.estimatePrice(c, est, 256);
  const checks = {
    one: s.requests.length === 1, method: s.requests[0]?.method === "POST", path: s.requests[0]?.path === "/v1/chat/completions",
    bearer: h.authorization === `Bearer ${SECRET}`, noXApiKey: !("x-api-key" in h), contentType: h["content-type"] === "application/json", host: h.host === `127.0.0.1:${s.port}`,
    bodyKeys: sortedKeys(b) === "max_completion_tokens,messages,model,n", noMaxTokens: !("max_tokens" in b), limit: b.max_completion_tokens === 256, model: b.model === MODEL["openai-compatible"],
    n1: b.n === 1, messages: canon(b.messages) === canon(rq.messages), secretNotInBody: !s.requests[0]?.raw.toString().includes(SECRET),
    text: o.r?.text === "qa reply" && o.r?.calls.length === 0 && o.r?.structured === null,
    receipt: rc?.schemaVersion === "1.0.0" && rc.provider === "openai-compatible" && rc.mode === "chat" && rc.evidence === "offline_http_fixture" && rc.modelId === c.modelId && rc.modelVersion === c.modelVersion && rc.configurationVersion === "qa88-cfg-1",
    profileHash: rc?.profileSha256 === contentHash(c), requestHash: rc?.requestSha256 === AC.requestHash("chat", rq), requestIdHash: rc?.requestIdSha256 === sha("chatcmpl-qa88"),
    transportHash: /^[a-f0-9]{64}$/.test(rc?.transportProfileSha256 ?? ""), usage: canon(rc?.usage) === canon({ source: "offline_http_fixture", inputTokens: 11, outputTokens: 7, actualCostMicros: null, tokenAccounting: "provider_reported_total" }),
    estimates: rc?.estimatedInputTokens === est && rc?.estimatedCostMicros === price && rc?.pricingVersion === "qa88-price-1", attempts: rc?.attempts === 1, deadline: rc?.deadlineAtMs === rq.deadlineAtMs,
  };
  return { pass: o.ok && Object.values(checks).every(Boolean), actual: { outcome: code(o), checks } };
});
let tpDefault = null, tpAlternate = null;
await probe("OpenAI-compatible trusted alternate output-limit field: max_tokens sent with the exact bounded value, never both; transport profile hash differs", "max_tokens=256, no max_completion_tokens; transportProfileSha256 differs from the default dialect", async () => {
  const s = await fake((r, res) => json(res, 200, oaBody()));
  const a = await outcome(() => OA(s).chat(request("chat"), ac()));
  const b = await outcome(() => OA(s, { openAiOutputLimitField: "max_tokens" }).chat(request("chat"), ac()));
  const c = await outcome(() => OA(s, { openAiOutputLimitField: "max_completion_tokens" }).chat(request("chat"), ac()));
  await s.close();
  tpDefault = a.r?.receipt.transportProfileSha256; tpAlternate = b.r?.receipt.transportProfileSha256;
  const [x, y, z] = s.requests.map((r) => r.body);
  const checks = { defaultField: x?.max_completion_tokens === 256 && !("max_tokens" in x), alternate: y?.max_tokens === 256 && !("max_completion_tokens" in y), explicitDefault: z?.max_completion_tokens === 256 && !("max_tokens" in z),
    hashDiffers: tpDefault !== tpAlternate, explicitDefaultSameHash: c.r?.receipt.transportProfileSha256 === tpDefault };
  return { pass: a.ok && b.ok && c.ok && Object.values(checks).every(Boolean), actual: checks };
});
await probe("OpenAI-compatible tools: strict function schema, required single call, no parallel calls; decoded call id hashed", "tools[{type:function,function:{name,parameters,strict:true}}], tool_choice=required, parallel_tool_calls=false; calls[0]={idSha256,name,arguments}", async () => {
  const s = await fake((r, res) => json(res, 200, oaBody({ content: null, finish: "tool_calls", calls: [{ id: "call_qa88", type: "function", function: { name: "qa_tool", arguments: '{"x":3}' } }] })));
  const o = await outcome(() => OA(s).tools(request("tools"), ac()));
  await s.close();
  const b = s.requests[0]?.body ?? {};
  const checks = { tools: canon(b.tools) === canon([{ type: "function", function: { name: "qa_tool", parameters: TOOL.inputSchema, strict: true } }]), choice: b.tool_choice === "required", parallel: b.parallel_tool_calls === false,
    noFormat: !("response_format" in b), call: canon(o.r?.calls) === canon([{ idSha256: sha("call_qa88"), name: "qa_tool", arguments: { x: 3 } }]), mode: o.r?.receipt.mode === "tools" };
  return { pass: o.ok && Object.values(checks).every(Boolean), actual: { outcome: code(o), checks } };
});
await probe("OpenAI-compatible structured: strict json_schema response_format; parsed object returned as structured, text null", "response_format {type:json_schema,json_schema:{name,schema,strict:true}}; structured={ok:true}", async () => {
  const s = await fake((r, res) => json(res, 200, oaBody({ content: '{"ok":true}' })));
  const o = await outcome(() => OA(s).structured(request("structured"), ac()));
  await s.close();
  const b = s.requests[0]?.body ?? {};
  const checks = { format: canon(b.response_format) === canon({ type: "json_schema", json_schema: { name: "qa_format", schema: FORMAT.schema, strict: true } }), noTools: !("tools" in b), structured: canon(o.r?.structured) === '{"ok":true}', text: o.r?.text === null };
  return { pass: o.ok && Object.values(checks).every(Boolean), actual: { outcome: code(o), checks } };
});
await probe("OpenAI-compatible vision: inline PNG only on the last message as data URL content part", "last message content=[text, image_url(data:image/png;base64,…)]; earlier messages plain", async () => {
  const s = await fake((r, res) => json(res, 200, oaBody()));
  const o = await outcome(() => OA(s).vision(request("vision"), ac()));
  await s.close();
  const m = s.requests[0]?.body?.messages ?? [];
  const checks = { first: m[0]?.content === "QA system instruction", last: canon(m[1]?.content) === canon([{ type: "text", text: "QA user data عربي English" }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }]) };
  return { pass: o.ok && Object.values(checks).every(Boolean), actual: { outcome: code(o), checks } };
});
await probe("Native Anthropic chat: distinct /messages wire, x-api-key + anthropic-version only, top-level system, max_tokens; cache-token input accounting", "POST /v1/messages; no Authorization; body {model,max_tokens,system,messages[blocks]}; inputTokens = 10+5+3 = 18; native_input_and_cache_sum", async () => {
  const s = await fake((r, res) => json(res, 200, anBody()));
  const c = caps("anthropic"), rq = request("chat"), o = await outcome(() => AN(s).chat(rq, ac()));
  await s.close();
  const h = s.requests[0]?.headers ?? {}, b = s.requests[0]?.body ?? {}, rc = o.r?.receipt;
  const checks = {
    path: s.requests[0]?.path === "/v1/messages", method: s.requests[0]?.method === "POST", apiKey: h["x-api-key"] === SECRET, version: h["anthropic-version"] === "2023-06-01", noBearer: !("authorization" in h),
    bodyKeys: sortedKeys(b) === "max_tokens,messages,model,system", limitField: b.max_tokens === 256, system: b.system === "QA system instruction",
    messages: canon(b.messages) === canon([{ role: "user", content: [{ type: "text", text: "QA user data عربي English" }] }]), secretNotInBody: !s.requests[0]?.raw.toString().includes(SECRET),
    usage: canon(rc?.usage) === canon({ source: "offline_http_fixture", inputTokens: 18, outputTokens: 4, actualCostMicros: null, tokenAccounting: NATIVE_SUM }),
    provenance: rc?.provider === "anthropic" && rc.profileSha256 === contentHash(c) && rc.requestIdSha256 === sha("msg_qa88") && rc.requestSha256 === AC.requestHash("chat", rq),
  };
  return { pass: o.ok && Object.values(checks).every(Boolean), actual: { outcome: code(o), checks } };
});
await probe("Native Anthropic tools: input_schema tools, tool_choice any with parallel disabled; tool_use decoded", "tools[{name,input_schema}], tool_choice {type:any,disable_parallel_tool_use:true}; calls[0]={sha(id),qa_tool,{x:3}}", async () => {
  const s = await fake((r, res) => json(res, 200, anBody({ stop: "tool_use", content: [{ type: "tool_use", id: "toolu_qa88", name: "qa_tool", input: { x: 3 } }] })));
  const o = await outcome(() => AN(s).tools(request("tools"), ac()));
  await s.close();
  const b = s.requests[0]?.body ?? {};
  const checks = { tools: canon(b.tools) === canon([{ name: "qa_tool", input_schema: TOOL.inputSchema }]), choice: canon(b.tool_choice) === canon({ type: "any", disable_parallel_tool_use: true }),
    call: canon(o.r?.calls) === canon([{ idSha256: sha("toolu_qa88"), name: "qa_tool", arguments: { x: 3 } }]) };
  return { pass: o.ok && Object.values(checks).every(Boolean), actual: { outcome: code(o), checks } };
});
await probe("Native Anthropic structured: forced named tool; structured from tool_use input; no calls leaked", "tools=[{name:qa_format,input_schema}], tool_choice {type:tool,name:qa_format}; structured={ok:true}, calls=[]", async () => {
  const s = await fake((r, res) => json(res, 200, anBody({ stop: "tool_use", content: [{ type: "tool_use", id: "toolu_fmt", name: "qa_format", input: { ok: true } }] })));
  const o = await outcome(() => AN(s).structured(request("structured"), ac()));
  await s.close();
  const b = s.requests[0]?.body ?? {};
  const checks = { tools: canon(b.tools) === canon([{ name: "qa_format", input_schema: FORMAT.schema }]), choice: canon(b.tool_choice) === canon({ type: "tool", name: "qa_format", disable_parallel_tool_use: true }),
    structured: canon(o.r?.structured) === '{"ok":true}', noCalls: o.r?.calls.length === 0, text: o.r?.text === null };
  return { pass: o.ok && Object.values(checks).every(Boolean), actual: { outcome: code(o), checks } };
});
await probe("Native Anthropic vision: base64 image block on the last non-system message", "content=[text,{type:image,source:{type:base64,media_type:image/png,data}}]", async () => {
  const s = await fake((r, res) => json(res, 200, anBody()));
  const o = await outcome(() => AN(s).vision(request("vision"), ac()));
  await s.close();
  const m = s.requests[0]?.body?.messages ?? [];
  const ok = canon(m) === canon([{ role: "user", content: [{ type: "text", text: "QA user data عربي English" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] }]);
  return { pass: o.ok && ok, actual: { outcome: code(o), lastMessageExact: ok } };
});
await probe("Usage honesty: absent usage is unavailable (null), never zero; Anthropic without cache fields counts input only", "OA no usage -> source unavailable, nulls; AN no usage -> unavailable; AN input only -> 10; actualCostMicros always null", async () => {
  const s1 = await fake((r, res) => json(res, 200, oaBody({ usage: null })));
  const a = await outcome(() => OA(s1).chat(request("chat"), ac())); await s1.close();
  const s2 = await fake((r, res) => json(res, 200, anBody({ usage: null })));
  const b = await outcome(() => AN(s2).chat(request("chat"), ac())); await s2.close();
  const s3 = await fake((r, res) => json(res, 200, anBody({ usage: { input_tokens: 10, output_tokens: 4 } })));
  const c = await outcome(() => AN(s3).chat(request("chat"), ac())); await s3.close();
  const un = canon({ source: "unavailable", inputTokens: null, outputTokens: null, actualCostMicros: null, tokenAccounting: "unavailable" });
  const checks = { oa: canon(a.r?.receipt.usage) === un, an: canon(b.r?.receipt.usage) === un, anInputOnly: c.r?.receipt.usage.inputTokens === 10 && c.r?.receipt.usage.actualCostMicros === null };
  return { pass: a.ok && b.ok && c.ok && Object.values(checks).every(Boolean), actual: checks };
});
// ---------------- Capability / request denial before any network effect ----------------
await probe("Capability denial and request validation fail before any request (0 server hits)", "undeclared mode -> unsupported_mode; caller endpoint field, mode-mismatched fields, oversize, bad roles, GIF/non-canonical/too many images -> invalid_request; context overflow -> budget_exceeded", async () => {
  const s = await fake((r, res) => json(res, 200, oaBody()));
  const chatOnly = OA(s, {}, { modes: ["chat"] }), p = OA(s);
  const cases = {
    toolsUndeclared: await outcome(() => chatOnly.tools(request("tools"), ac())), structuredUndeclared: await outcome(() => chatOnly.structured(request("structured"), ac())), visionUndeclared: await outcome(() => chatOnly.vision(request("vision"), ac())),
    callerEndpoint: await outcome(() => p.chat({ ...request("chat"), endpoint: "http://169.254.169.254/latest" }, ac())),
    callerHeaders: await outcome(() => p.chat({ ...request("chat"), headers: { authorization: "x" } }, ac())),
    toolsInChat: await outcome(() => p.chat({ ...request("chat"), tools: [TOOL] }, ac())), imagesInChat: await outcome(() => p.chat({ ...request("chat"), images: [{ mediaType: "image/png", base64: PNG }] }, ac())),
    formatInTools: await outcome(() => p.tools({ ...request("tools"), format: FORMAT }, ac())), toolsEmpty: await outcome(() => p.tools({ ...request("chat"), tools: [] }, ac())),
    outputOverCap: await outcome(() => p.chat(request("chat", { maxOutputTokens: 1025 }), ac())), roleTool: await outcome(() => p.chat(request("chat", { messages: [{ role: "tool", content: "x" }] }), ac())),
    tooManyMessages: await outcome(() => p.chat(request("chat", { messages: Array.from({ length: 33 }, () => ({ role: "user", content: "x" })) }), ac())),
    badToolName: await outcome(() => p.tools(request("tools", { tools: [{ ...TOOL, name: "bad name!" }] }), ac())),
    gif: await outcome(() => p.vision(request("vision", { images: [{ mediaType: "image/gif", base64: PNG }] }), ac())),
    nonCanonicalBase64: await outcome(() => p.vision(request("vision", { images: [{ mediaType: "image/png", base64: "aGVsbG8" }] }), ac())),
    fiveImages: await outcome(() => p.vision(request("vision", { images: Array.from({ length: 5 }, () => ({ mediaType: "image/png", base64: PNG })) }), ac())),
    urlImage: await outcome(() => p.vision(request("vision", { images: [{ mediaType: "image/png", base64: PNG, url: "http://169.254.169.254/" }] }), ac())),
    contextOverflow: await outcome(() => p.chat(request("chat", { messages: [{ role: "user", content: "x".repeat(33_000) }] }), ac())),
  };
  await s.close();
  const codes = Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, code(v)]));
  const expect = { toolsUndeclared: "unsupported_mode", structuredUndeclared: "unsupported_mode", visionUndeclared: "unsupported_mode", contextOverflow: "budget_exceeded" };
  const pass = Object.entries(codes).every(([k, v]) => v === (expect[k] ?? "invalid_request")) && s.requests.length === 0;
  return { pass, actual: { codes, serverHits: s.requests.length } };
});
await probe("Output-limit dialect is trusted OpenAI-compatible configuration only", "openAiOutputLimitField on Anthropic or an unknown value -> endpoint_denied at construction", async () => {
  const s = await fake((r, res) => json(res, 200, anBody()));
  const a = await outcome(async () => AN(s, { openAiOutputLimitField: "max_tokens" }));
  const b = await outcome(async () => OA(s, { openAiOutputLimitField: "max_output_tokens" }));
  await s.close();
  return { pass: code(a) === "endpoint_denied" && code(b) === "endpoint_denied" && s.requests.length === 0, actual: { anthropic: code(a), unknown: code(b) } };
});
// ---------------- Strict response validation (each exactly one attempt, never retried) ----------------
await probe("OpenAI-compatible strict response decoding (refusal/truncation/shape/model/args/encoding/usage) with no retries", "refused/truncated/invalid_response typed outcomes; exactly one request each", async () => {
  const bad = {
    wrongModel: oaBody({ model: "other-model" }), twoChoices: oaBody({ choices: [oaBody().choices[0], oaBody().choices[0]] }), refusal: oaBody({ refusal: "no" }), contentFilter: oaBody({ finish: "content_filter" }),
    length: oaBody({ finish: "length" }), unknownFinish: oaBody({ finish: "weird" }), callsInChat: oaBody({ finish: "tool_calls", calls: [{ id: "c", type: "function", function: { name: "qa_tool", arguments: "{}" } }] }),
    negativeUsage: oaBody({ usage: { prompt_tokens: -1, completion_tokens: 1 } }), hugeUsage: oaBody({ usage: { prompt_tokens: 10_000_001, completion_tokens: 1 } }), partialUsage: oaBody({ usage: { prompt_tokens: 3 } }),
    nonJson: "not json at all", arrayTop: [oaBody()], invalidUtf8: Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xc3, 0x28, 0x7d]),
  };
  const expect = { refusal: "refused", contentFilter: "refused", length: "truncated" };
  const codes = {}, hits = {};
  for (const [k, body] of Object.entries(bad)) {
    const s = await fake((r, res) => { if (Buffer.isBuffer(body)) { res.writeHead(200, { "content-type": "application/json", "content-length": body.length }); res.end(body); } else json(res, 200, body); });
    codes[k] = code(await outcome(() => OA(s).chat(request("chat"), ac()))); hits[k] = s.requests.length; await s.close();
  }
  const toolsBad = {
    noCall: oaBody({ finish: "tool_calls", content: null }), twoCalls: oaBody({ finish: "tool_calls", content: null, calls: [1, 2].map((i) => ({ id: `c${i}`, type: "function", function: { name: "qa_tool", arguments: "{}" } })) }),
    unrequestedTool: oaBody({ finish: "tool_calls", content: null, calls: [{ id: "c", type: "function", function: { name: "shell_exec", arguments: "{}" } }] }),
    argsNotJson: oaBody({ finish: "tool_calls", content: null, calls: [{ id: "c", type: "function", function: { name: "qa_tool", arguments: "{x:" } }] }),
    finishStopWithCall: oaBody({ finish: "stop", content: null, calls: [{ id: "c", type: "function", function: { name: "qa_tool", arguments: "{}" } }] }),
  };
  for (const [k, body] of Object.entries(toolsBad)) { const s = await fake((r, res) => json(res, 200, body)); codes[`tools.${k}`] = code(await outcome(() => OA(s).tools(request("tools"), ac()))); hits[`tools.${k}`] = s.requests.length; await s.close(); }
  { const s = await fake((r, res) => json(res, 200, oaBody({ content: "{not json" }))); codes["structured.notJson"] = code(await outcome(() => OA(s).structured(request("structured"), ac()))); hits["structured.notJson"] = s.requests.length; await s.close(); }
  const pass = Object.entries(codes).every(([k, v]) => v === (expect[k] ?? "invalid_response")) && Object.values(hits).every((h) => h === 1);
  return { pass, actual: { codes, everyCaseOneRequest: Object.values(hits).every((h) => h === 1) } };
});
await probe("Native Anthropic strict response decoding with no retries", "refusal -> refused; max_tokens/context-window -> truncated; wrong type/role/model/stop, tool-name mismatch, missing/extra tool_use -> invalid_response; unknown block -> typed failure", async () => {
  const cases = {
    wrongType: ["chat", anBody({ type: "completion" })], wrongRole: ["chat", anBody({ role: "user" })], wrongModel: ["chat", anBody({ model: "x" })], refusal: ["chat", anBody({ stop: "refusal" })],
    maxTokens: ["chat", anBody({ stop: "max_tokens" })], contextWindow: ["chat", anBody({ stop: "model_context_window_exceeded" })], unknownStop: ["chat", anBody({ stop: "pause_turn" })],
    unknownBlock: ["chat", anBody({ content: [{ type: "thinking", thinking: "x" }] })], toolUseInChat: ["chat", anBody({ stop: "tool_use", content: [{ type: "tool_use", id: "t", name: "qa_tool", input: {} }] })],
    toolsEndTurn: ["tools", anBody({ stop: "end_turn" })], twoToolUse: ["tools", anBody({ stop: "tool_use", content: [1, 2].map((i) => ({ type: "tool_use", id: `t${i}`, name: "qa_tool", input: {} })) })],
    unrequestedTool: ["tools", anBody({ stop: "tool_use", content: [{ type: "tool_use", id: "t", name: "bash", input: {} }] })],
    structuredWrongName: ["structured", anBody({ stop: "tool_use", content: [{ type: "tool_use", id: "t", name: "other", input: { ok: true } }] })],
    cacheNegative: ["chat", anBody({ usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: -5 } })],
  };
  const expect = { refusal: "refused", maxTokens: "truncated", contextWindow: "truncated", unknownBlock: "unsupported_mode" };
  const codes = {}, hits = {};
  for (const [k, [mode, body]] of Object.entries(cases)) { const s = await fake((r, res) => json(res, 200, body)); codes[k] = code(await outcome(() => AN(s)[mode](request(mode), ac()))); hits[k] = s.requests.length; await s.close(); }
  const pass = Object.entries(codes).every(([k, v]) => v === (expect[k] ?? "invalid_response")) && Object.values(hits).every((h) => h === 1);
  return { pass, actual: { codes, everyCaseOneRequest: Object.values(hits).every((h) => h === 1) } };
});
// ---------------- HTTP status, retry and unknown-outcome semantics ----------------
await probe("Non-retryable HTTP statuses: one attempt, typed result; redirects are not followed", "400/404 -> invalid_request; 401/403 -> authentication; 500/502 -> unavailable; 307 -> invalid_request with 0 hits on the redirect target", async () => {
  const target = await fake((r, res) => json(res, 200, oaBody()));
  const codes = {}, hits = {};
  for (const st of [400, 401, 403, 404, 500, 502, 307]) {
    const s = await fake((r, res) => (st === 307 ? json(res, 307, "{}", { location: `${target.origin}/v1/chat/completions` }) : json(res, st, { error: { message: "qa" } })));
    codes[st] = code(await outcome(() => OA(s).chat(request("chat"), ac()))); hits[st] = s.requests.length; await s.close();
  }
  await target.close();
  const expect = { 400: "invalid_request", 401: "authentication", 403: "authentication", 404: "invalid_request", 500: "unavailable", 502: "unavailable", 307: "invalid_request" };
  const pass = Object.entries(expect).every(([k, v]) => codes[k] === v) && Object.values(hits).every((h) => h === 1) && target.requests.length === 0;
  return { pass, actual: { codes, oneAttemptEach: Object.values(hits).every((h) => h === 1), redirectTargetHits: target.requests.length } };
});
await probe("Safe 429/503 retries bounded by 3 with jittered backoff; every attempt reserves budget and estimated cost", "429,429,200 -> success attempts=3 (gaps 100..1000 ms), estimatedCostMicros = 3x estimate, budget attempts=3; 503x3 -> unavailable after 3; 429x3 -> rate_limited after 3; maxAttempts=1 -> no retry", async () => {
  const seq = [429, 429, 200];
  const s1 = await fake((r, res, i) => (seq[i - 1] === 200 ? json(res, 200, oaBody()) : json(res, seq[i - 1], { error: {} })));
  const b1 = budget(), c = caps("openai-compatible"), rq = request("chat");
  const a = await outcome(() => OA(s1, {}, {}, b1).chat(rq, ac())); await s1.close();
  const gaps = s1.requests.slice(1).map((r, i) => r.at - s1.requests[i].at);
  const s2 = await fake((r, res) => json(res, 503, {})); const u = await outcome(() => OA(s2).chat(request("chat"), ac())); await s2.close();
  const s3 = await fake((r, res) => json(res, 429, {})); const rl = await outcome(() => OA(s3).chat(request("chat"), ac())); await s3.close();
  const s4 = await fake((r, res) => json(res, 429, {})); const one = await outcome(() => OA(s4, { maxAttempts: 1 }).chat(request("chat"), ac())); await s4.close();
  const est = AC.estimatePrice(c, AC.estimateRequest(rq), 256);
  const checks = { success: a.ok && a.r.receipt.attempts === 3 && s1.requests.length === 3, gapsBounded: gaps.every((g) => g >= 95 && g < 1000), cost: a.r?.receipt.estimatedCostMicros === est * 3,
    budgetAttempts: b1.snapshot().attempts === 3, unavailable: code(u) === "unavailable" && s2.requests.length === 3, rateLimited: code(rl) === "rate_limited" && s3.requests.length === 3, maxOne: code(one) === "rate_limited" && s4.requests.length === 1 };
  return { pass: Object.values(checks).every(Boolean), actual: { checks, gapsMs: gaps } };
});
await probe("Retry-After honoured and bounded: delta-seconds and HTTP-date waited; >60 s or unparseable refuses immediately", "Retry-After: 1 -> next attempt >= ~1 s later; HTTP-date (+2 s) -> waited; 61 / garbage -> rate_limited after 1 attempt (no wait)", async () => {
  const mk = async (hdr) => { const s = await fake((r, res, i) => (i === 1 ? json(res, 429, {}, { "retry-after": hdr }) : json(res, 200, oaBody()))); const t = Date.now(); const o = await outcome(() => OA(s, { timeoutMs: 10_000 }).chat(request("chat"), ac())); await s.close(); return { o, s, ms: Date.now() - t }; };
  const d1 = await mk("1"), date = await mk(new Date(Date.now() + 2500).toUTCString()), long = await mk("61"), junk = await mk("soon");
  const s5 = await fake((r, res) => json(res, 503, {}, { "retry-after": "61" })); const u = await outcome(() => OA(s5).chat(request("chat"), ac())); await s5.close();
  const gap = (x) => (x.s.requests.length > 1 ? x.s.requests[1].at - x.s.requests[0].at : null);
  const checks = { delta: d1.o.ok && gap(d1) >= 950, httpDate: date.o.ok && gap(date) >= 900, longRefused: code(long.o) === "rate_limited" && long.s.requests.length === 1 && long.ms < 2000,
    junkRefused: code(junk.o) === "rate_limited" && junk.s.requests.length === 1, long503Stops: s5.requests.length === 1 && ["rate_limited", "unavailable"].includes(code(u)) };
  return { pass: Object.values(checks).every(Boolean), actual: { checks, gapsMs: { delta: gap(d1), httpDate: gap(date) }, long503Code: code(u) } };
});
await probe("Unknown/uncertain outcomes are never retried: reset after request, truncated body, oversize body", "socket destroyed after request -> transport_unknown, 1 attempt; truncated body -> transport_unknown/timeout, 1 attempt; >maxResponseBytes -> invalid_response, 1 attempt", async () => {
  const reset = await fake((r, res) => res.socket.destroy()); const a = await outcome(() => OA(reset, { timeoutMs: 3000 }).chat(request("chat"), ac())); await reset.close();
  const trunc = await fake((r, res) => { res.writeHead(200, { "content-type": "application/json", "content-length": 5000 }); res.write('{"id":"x","choices":['); setTimeout(() => res.socket.destroy(), 50); });
  const b = await outcome(() => OA(trunc, { timeoutMs: 3000 }).chat(request("chat"), ac())); await trunc.close();
  const big = await fake((r, res) => json(res, 200, oaBody({ content: "x".repeat(80_000) }))); const c = await outcome(() => OA(big, { maxResponseBytes: 65536 }).chat(request("chat"), ac())); await big.close();
  const checks = { reset: code(a) === "transport_unknown" && reset.requests.length === 1, truncated: ["transport_unknown", "timeout"].includes(code(b)) && trunc.requests.length === 1, oversize: code(c) === "invalid_response" && big.requests.length === 1 };
  return { pass: Object.values(checks).every(Boolean), actual: { codes: { reset: code(a), truncated: code(b), oversize: code(c) }, checks } };
});
await probe("Deadline, timeout and cancellation are typed and bounded", "deadline in past -> timeout, 0 hits; pre-aborted -> cancelled, 0 hits; slow server past deadline -> timeout ~deadline; transport timeoutMs bound; abort in flight -> cancelled; none retried", async () => {
  const slow = await fake((r, res) => setTimeout(() => { if (!res.writableEnded && !res.destroyed) json(res, 200, oaBody()); }, 4000));
  const past = await outcome(() => OA(slow).chat(request("chat", { deadlineAtMs: Date.now() - 1 }), ac()));
  const pre = new AbortController(); pre.abort();
  const preA = await outcome(() => OA(slow).chat(request("chat"), pre.signal));
  const before = slow.requests.length;
  let t = Date.now(); const dl = await outcome(() => OA(slow).chat(request("chat", { deadlineAtMs: Date.now() + 600 }), ac())); const dlMs = Date.now() - t;
  t = Date.now(); const to = await outcome(() => OA(slow, { timeoutMs: 400 }).chat(request("chat"), ac())); const toMs = Date.now() - t;
  const ab = new AbortController(); setTimeout(() => ab.abort(), 300);
  t = Date.now(); const inflight = await outcome(() => OA(slow).chat(request("chat"), ab.signal)); const abMs = Date.now() - t;
  await new Promise((r) => setTimeout(r, 200)); await slow.close();
  const checks = { past: code(past) === "timeout", preAborted: code(preA) === "cancelled", zeroHitsBefore: before === 0, deadline: code(dl) === "timeout" && dlMs < 1500, timeoutMs: code(to) === "timeout" && toMs < 1300,
    inflight: code(inflight) === "cancelled" && abMs < 1300, oneHitEach: slow.requests.length === 3 };
  return { pass: Object.values(checks).every(Boolean), actual: { checks, ms: { deadline: dlMs, timeout: toMs, abort: abMs }, hits: slow.requests.length } };
});
await probe("Concurrency admission: shared minimum spacing across concurrent calls on one adapter", "minIntervalMs=300, 3 concurrent calls -> server arrivals spaced >= ~280 ms, all succeed", async () => {
  const s = await fake((r, res) => json(res, 200, oaBody()));
  const p = OA(s, { minIntervalMs: 300 });
  const all = await Promise.all([0, 1, 2].map(() => outcome(() => p.chat(request("chat"), ac()))));
  await s.close();
  const at = s.requests.map((r) => r.at).sort((a, b) => a - b), gaps = at.slice(1).map((v, i) => v - at[i]);
  return { pass: all.every((o) => o.ok) && gaps.length === 2 && gaps.every((g) => g >= 280), actual: { gapsMs: gaps } };
});
await probe("Token/cost/call budgets refuse before transport; retries consume the call budget; unpriced profile cannot reserve cost", "token or cost limit -> budget_exceeded with 0 hits; calls=1 -> second call budget_exceeded (1 hit total); calls=2 with 429,429 -> budget_exceeded after 2 hits; pricing null -> budget_exceeded, 0 hits", async () => {
  const s = await fake((r, res) => json(res, 200, oaBody()));
  const tok = await outcome(() => OA(s, {}, {}, budget({ tokens: 100 })).chat(request("chat"), ac()));
  const cost = await outcome(() => OA(s, {}, {}, budget({ costMicros: 0 })).chat(request("chat"), ac()));
  const noPrice = await outcome(() => OA(s, {}, { pricing: null }).chat(request("chat"), ac()));
  const zeroHits = s.requests.length;
  const p1 = OA(s, {}, {}, budget({ calls: 1 }));
  const first = await outcome(() => p1.chat(request("chat"), ac())), second = await outcome(() => p1.chat(request("chat"), ac()));
  const hitsAfterCalls = s.requests.length; await s.close();
  const r = await fake((q, res) => json(res, 429, {}));
  const retry = await outcome(() => OA(r, {}, {}, budget({ calls: 2 })).chat(request("chat"), ac())); await r.close();
  const checks = { tokens: code(tok) === "budget_exceeded", cost: code(cost) === "budget_exceeded", unpriced: code(noPrice) === "budget_exceeded", zeroHits: zeroHits === 0,
    callLimit: first.ok && code(second) === "budget_exceeded" && hitsAfterCalls === 1, retryConsumes: code(retry) === "budget_exceeded" && r.requests.length === 2 };
  return { pass: Object.values(checks).every(Boolean), actual: checks };
});
// ---------------- Endpoint / SSRF / address pinning / TLS ----------------
await probe("Trusted endpoint policy: origin allowlist, no userinfo/query/fragment, HTTPS except loopback fixtures, bounded transport limits", "each misconfiguration -> endpoint_denied at construction", async () => {
  const base = "http://127.0.0.1:9";
  const bad = {
    originNotAllowed: [base + "/v1", { allowedOrigins: ["http://127.0.0.1:10"] }], userinfo: ["http://u:p@127.0.0.1:9/v1", { allowedOrigins: ["http://127.0.0.1:9"] }], query: [base + "/v1?x=1", {}], fragment: [base + "/v1#f", {}],
    httpNonLoopback: ["http://10.0.0.5/v1", { allowedAddresses: ["10.0.0.5"] }], httpLocalhostName: ["http://localhost:9/v1", { allowedAddresses: ["127.0.0.1"] }], ftp: ["ftp://127.0.0.1/v1", {}],
    noAddresses: [base + "/v1", { allowedAddresses: [] }], hostnameAsAddress: [base + "/v1", { allowedAddresses: ["localhost"] }], linkLocalV4: [base + "/v1", { allowedAddresses: ["169.254.169.254"] }],
    timeout0: [base + "/v1", { timeoutMs: 0 }], timeoutHuge: [base + "/v1", { timeoutMs: 60_001 }], attempts4: [base + "/v1", { maxAttempts: 4 }], attempts0: [base + "/v1", { maxAttempts: 0 }],
    responseTooSmall: [base + "/v1", { maxResponseBytes: 63 }], responseTooBig: [base + "/v1", { maxResponseBytes: 1_048_577 }], secretNotFunction: [base + "/v1", { secret: SECRET }],
  };
  const codes = {};
  for (const [k, [ep, over]] of Object.entries(bad)) codes[k] = code(await outcome(async () => new AC.OpenAICompatibleProvider(caps("openai-compatible"), { ...policy(ep), ...over }, budget())));
  codes.httpOperatorEvidence = code(await outcome(async () => new AC.OpenAICompatibleProvider(caps("openai-compatible", { evidence: "operator_declared_unqualified" }), policy(base + "/v1"), budget())));
  return { pass: Object.values(codes).every((c) => c === "endpoint_denied"), actual: codes };
});
await probe("Address allowlist excludes link-local / metadata addresses in IPv6 and IPv4-mapped forms too", "both adapters reject 169.254/16, fe80::/10, zone, expanded and IPv4-mapped forms, a numeric literal and a name that resolves to 169.254.169.254, all before the secret callback; loopback and non-link-local addresses still construct", async () => {
  let secretReads = 0;
  const counted = (endpoint, over = {}) => policy(endpoint, { ...over, secret: () => { secretReads += 1; return SECRET; } });
  const adapters = [["openai-compatible", AC.OpenAICompatibleProvider], ["anthropic", AC.AnthropicProvider]];
  const blocked = ["169.254.1.1", "fe80::1", "FE80::abcd", "febf::1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "0:0:0:0:0:FFFF:A9FE:A9FE", "fe80::1%eth0", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"];
  const allowed = ["127.0.0.1", "::1", "::ffff:127.0.0.1", "192.0.2.1", "2001:db8::1", "fe7f::1", "fec0::1", "169.253.255.255", "169.255.0.0", "0:0:0:0:0:ffff:7f00:1"];
  const deny = {}, allow = {}, literal = {}, dns = {};
  for (const [name, Ctor] of adapters) {
    for (const a of blocked) deny[`${name}:${a}`] = code(await outcome(async () => new Ctor(caps(name), counted("http://127.0.0.1:9/v1", { allowedAddresses: ["127.0.0.1", a] }), budget())));
    for (const a of allowed) allow[`${name}:${a}`] = code(await outcome(async () => new Ctor(caps(name), counted("http://127.0.0.1:9/v1", { allowedAddresses: [a] }), budget())));
    for (const a of blocked.filter((x) => !x.includes("%"))) {
      const ep = `https://${a.includes(":") ? `[${a}]` : a}/v1`;
      literal[`${name}:${a}`] = code(await outcome(async () => new Ctor(caps(name), counted(ep, { allowedOrigins: [new URL(ep).origin], allowedAddresses: ["192.0.2.1"] }), budget())));
    }
    const numeric = "https://0xa9fea9fe/v1";
    literal[`${name}:numeric`] = code(await outcome(async () => new Ctor(caps(name), counted(numeric, { allowedOrigins: [new URL(numeric).origin], allowedAddresses: ["192.0.2.1"] }), budget())));
    const host = process.env.QA88_LINKLOCAL_HOST || "qa88-ll.invalid";
    dns[name] = code(await outcome(async () => {
      const model = new Ctor(caps(name), counted(`https://${host}/v1`, { allowedAddresses: ["192.0.2.1"] }), budget());
      return model.chat(request("chat"), ac());
    }));
  }
  const checks = {
    denied: Object.values(deny).every((c) => c === "endpoint_denied"),
    literals: Object.values(literal).every((c) => c === "endpoint_denied"),
    dns: Object.values(dns).every((c) => c === "endpoint_denied"),
    allowed: Object.values(allow).every((c) => c === "OK"),
    secretNotRead: secretReads === 0,
  };
  return { pass: Object.values(checks).every(Boolean), actual: { checks, secretReads, deny, literal, dns, allow } };
});
await probe("Dispatch is pinned to allowlisted addresses: a literal or resolved address outside the set is refused before connecting", "IP literal not in allowedAddresses -> endpoint_denied, 0 connections; https://localhost resolving outside {127.0.0.2} -> endpoint_denied, 0 connections", async () => {
  const s = await fake((r, res) => json(res, 200, oaBody()));
  const lit = await outcome(() => OA(s, { allowedAddresses: ["127.0.0.2"] }).chat(request("chat"), ac()));
  const host = await outcome(() => new AC.OpenAICompatibleProvider(caps("openai-compatible"), policy(`https://localhost:${s.port}/v1`, { allowedAddresses: ["127.0.0.2"] }), budget()).chat(request("chat"), ac()));
  await s.close();
  return { pass: code(lit) === "endpoint_denied" && code(host) === "endpoint_denied" && s.sockets.connections === 0, actual: { literal: code(lit), hostname: code(host), connections: s.sockets.connections } };
});
const tlsFiles = TLS && existsSync(path.join(TLS, "good.crt")) ? {
  good: { key: readFileSync(path.join(TLS, "good.key")), cert: readFileSync(path.join(TLS, "good.crt")) },
  host: { key: readFileSync(path.join(TLS, "host.key")), cert: readFileSync(path.join(TLS, "host.crt")) },
  wrong: { key: readFileSync(path.join(TLS, "wrong.key")), cert: readFileSync(path.join(TLS, "wrong.crt")) },
  self: { key: readFileSync(path.join(TLS, "self.key")), cert: readFileSync(path.join(TLS, "self.crt")) },
} : null;
await probe("TLS: trusted certificate succeeds; wrong-name and untrusted certificates fail closed without HTTP or retry; hostname pinned to an allowed address keeps name validation", "CA-trusted IP SAN -> OK; trusted CA wrong SAN -> transport_unknown, 1 connection, 0 requests; self-signed -> transport_unknown; https://localhost (allowed 127.0.0.1/::1, SAN DNS:localhost) -> OK via an allowlisted peer", async () => {
  if (!tlsFiles) return { pass: false, actual: "tls fixtures missing" };
  const g = await fake((r, res) => json(res, 200, oaBody()), { tls: tlsFiles.good }); const ok = await outcome(() => OA(g).chat(request("chat"), ac())); await g.close();
  const w = await fake((r, res) => json(res, 200, oaBody()), { tls: tlsFiles.wrong }); const wrong = await outcome(() => OA(w).chat(request("chat"), ac())); await w.close();
  const sf = await fake((r, res) => json(res, 200, oaBody()), { tls: tlsFiles.self }); const self = await outcome(() => OA(sf).chat(request("chat"), ac())); await sf.close();
  const h = await fake((r, res) => json(res, 200, oaBody()), { tls: tlsFiles.host, dual: true });
  const named = await outcome(() => new AC.OpenAICompatibleProvider(caps("openai-compatible"), policy(`https://localhost:${h.port}/v1`, { allowedAddresses: ["127.0.0.1", "::1"] }), budget()).chat(request("chat"), ac())); await h.close();
  const checks = { trusted: ok.ok && g.requests.length === 1, wrongName: code(wrong) === "transport_unknown" && w.requests.length === 0 && w.sockets.connections === 1, selfSigned: code(self) === "transport_unknown" && sf.requests.length === 0 && sf.sockets.connections === 1,
    pinnedName: named.ok && h.requests.length === 1 && ["127.0.0.1", "::ffff:127.0.0.1", "::1"].includes(h.requests[0]?.remote), pinnedHostHeader: h.requests[0]?.headers.host === `localhost:${h.port}` };
  return { pass: Object.values(checks).every(Boolean), actual: { checks, codes: { trusted: code(ok), wrongName: code(wrong), selfSigned: code(self), named: code(named) } } };
});
await probe("Credential handling: header-unsafe/empty secrets refused before sending; secret callback failure sends nothing", "CR/LF secret -> authentication, 0 hits; empty -> authentication, 0 hits; throwing callback -> typed failure, 0 hits", async () => {
  const s = await fake((r, res) => json(res, 200, oaBody()));
  const crlf = await outcome(() => OA(s, { secret: () => `${SECRET}\r\nx-injected: 1` }).chat(request("chat"), ac()));
  const empty = await outcome(() => OA(s, { secret: () => "" }).chat(request("chat"), ac()));
  const throwing = await outcome(() => OA(s, { secret: () => { throw new Error(SECRET); } }).chat(request("chat"), ac()));
  await s.close();
  return { pass: code(crlf) === "authentication" && code(empty) === "authentication" && !throwing.ok && s.requests.length === 0, actual: { crlf: code(crlf), empty: code(empty), throwingCallback: code(throwing), hits: s.requests.length } };
});
await probe("Transport profile hash binds endpoint/limits/dialect but excludes the secret value; capability profile hash binds model/config/pricing", "same policy with different secret -> identical transportProfileSha256; different timeout -> different; profileSha256 changes with modelVersion/configurationVersion/pricing", async () => {
  const s = await fake((r, res) => json(res, 200, oaBody()));
  const t = async (over, cOver = {}) => (await OA(s, over, cOver).chat(request("chat"), ac())).receipt;
  const a = await t({}), b = await t({ secret: () => SECRET + "-other" }), c = await t({ timeoutMs: 4000 }), d = await t({}, { modelVersion: "2026-11-qa" }), e = await t({}, { configurationVersion: "qa88-cfg-2" }), f = await t({}, { pricing: { ...caps("openai-compatible").pricing, inputMicrosPerMillionTokens: 1 } });
  await s.close();
  const checks = { hashExcludesCallbackValue: a.transportProfileSha256 === b.transportProfileSha256, limitsBound: a.transportProfileSha256 !== c.transportProfileSha256, modelVersion: a.profileSha256 !== d.profileSha256, configVersion: a.profileSha256 !== e.profileSha256 && e.configurationVersion === "qa88-cfg-2", pricing: a.profileSha256 !== f.profileSha256 };
  return { pass: Object.values(checks).every(Boolean), actual: checks };
});
await probe("Configuration-only provider switching: configuredHttpProvider selects the protocol from trusted capabilities; replay/unknown names refused", "openai-compatible -> /chat/completions dialect; anthropic -> /messages dialect; replay via HTTP -> invalid_request; selectProvider(unknown) -> invalid_request", async () => {
  const s = await fake((r, res) => json(res, 200, r.path.endsWith("/messages") ? anBody() : oaBody()));
  const mk = (provider) => AC.configuredHttpProvider({ capabilities: caps(provider), transport: policy(`${s.origin}/v1`) }, budget());
  const o = await outcome(() => mk("openai-compatible").chat(request("chat"), ac())), a = await outcome(() => mk("anthropic").chat(request("chat"), ac()));
  const r = await outcome(async () => mk("replay")), sel = await outcome(async () => AC.selectProvider("hosted-default", new Map([["qa", mk("openai-compatible")]])));
  await s.close();
  const checks = { openai: o.ok && s.requests[0]?.path === "/v1/chat/completions", anthropic: a.ok && s.requests[1]?.path === "/v1/messages", replayRefused: code(r) === "invalid_request", unknownName: code(sel) === "invalid_request" };
  return { pass: Object.values(checks).every(Boolean), actual: checks };
});
// ---------------- Deterministic replay ----------------
const replayCaps = caps("replay", { pricing: { version: "qa88-synthetic-zero", provenance: "synthetic_fixture", inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 } });
const entry = (mode, rq, reply = { text: mode === "chat" || mode === "vision" ? "replayed" : null, calls: mode === "tools" ? [{ idSha256: sha("r1"), name: "qa_tool", arguments: { x: 1 } }] : [], structured: mode === "structured" ? { ok: true } : null }) =>
  ({ mode, requestSha256: AC.requestHash(mode, rq), reply, syntheticUsage: { inputTokens: 5, outputTokens: 6 } });
await probe("Replay: all four modes, deterministic across fresh providers, synthetic receipt (null transport hash, zero synthetic duration, cost null)", "two fresh providers with the same cassette -> deep-equal replies/receipts; usage source synthetic_replay; transportProfileSha256 null; durationMs 0; actualCostMicros null", async () => {
  const fixed = Date.now() + 60_000, reqs = Object.fromEntries(["chat", "tools", "structured", "vision"].map((m) => [m, request(m, { deadlineAtMs: fixed })]));
  const cassette = Object.entries(reqs).map(([m, rq]) => entry(m, rq));
  const run = async () => { const p = new AC.ReplayProvider(replayCaps, cassette); const out = []; for (const [m, rq] of Object.entries(reqs)) out.push(await p[m](rq, ac())); return out; };
  const a = await run(), b = await run();
  const checks = { deterministic: canon(a) === canon(b), modes: a.map((x) => x.receipt.mode).join() === "chat,tools,structured,vision",
    synthetic: a.every((x) => x.receipt.usage.source === "synthetic_replay" && x.receipt.usage.actualCostMicros === null && x.receipt.transportProfileSha256 === null && x.receipt.durationMs === 0 && x.receipt.evidence === "synthetic_replay" && x.receipt.requestIdSha256 === null) };
  return { pass: Object.values(checks).every(Boolean), actual: checks };
});
await probe("Replay refuses tampered/mismatched cassettes and requests", "changed request -> invalid_request; mode mismatch -> invalid_request; exhausted cassette -> invalid_request; malformed hash / tool name / usage at construction -> invalid_request; replay profile with non-synthetic evidence -> invalid_request", async () => {
  const rq = request("chat", { deadlineAtMs: Date.now() + 60_000 }), good = entry("chat", rq);
  const changed = await outcome(() => new AC.ReplayProvider(replayCaps, [good]).chat({ ...rq, messages: [{ role: "user", content: "different" }] }, ac()));
  const modeMismatch = await outcome(() => new AC.ReplayProvider(replayCaps, [good]).structured(request("structured", { deadlineAtMs: rq.deadlineAtMs }), ac()));
  const p = new AC.ReplayProvider(replayCaps, [good]); await p.chat(rq, ac()); const exhausted = await outcome(() => p.chat(rq, ac()));
  const ctor = async (e, c = replayCaps) => code(await outcome(async () => new AC.ReplayProvider(c, e)));
  const codes = {
    changed: code(changed), modeMismatch: code(modeMismatch), exhausted: code(exhausted),
    upperHash: await ctor([{ ...good, requestSha256: good.requestSha256.toUpperCase() }]), shortHash: await ctor([{ ...good, requestSha256: good.requestSha256.slice(1) }]),
    badCallName: await ctor([{ ...entry("tools", request("tools")), reply: { text: null, structured: null, calls: [{ idSha256: sha("x"), name: "rm -rf /", arguments: {} }] } }]),
    negativeUsage: await ctor([{ ...good, syntheticUsage: { inputTokens: -1, outputTokens: 0 } }]), seventeen: await ctor(Array.from({ length: 17 }, () => good)),
    nonSyntheticEvidence: await ctor([good], { ...replayCaps, evidence: "offline_http_fixture" }),
  };
  return { pass: Object.values(codes).every((c) => c === "invalid_request"), actual: codes };
});
await probe("Record -> replay roundtrip from an offline HTTP fixture reply; live/operator-declared receipts cannot be recorded", "recordReplayEntry(offline fixture) then ReplayProvider returns identical text/calls/structured; recording an operator_declared receipt -> invalid_request", async () => {
  const s = await fake((r, res) => json(res, 200, oaBody({ content: null, finish: "tool_calls", calls: [{ id: "call_rec", type: "function", function: { name: "qa_tool", arguments: '{"x":9}' } }] })));
  const rq = request("tools", { deadlineAtMs: Date.now() + 60_000 }), live = await OA(s).tools(rq, ac()); await s.close();
  const e = AC.recordReplayEntry("tools", rq, live), back = await new AC.ReplayProvider(replayCaps, [e]).tools(rq, ac());
  const op = await outcome(async () => AC.recordReplayEntry("tools", rq, { ...live, receipt: { ...live.receipt, evidence: "operator_declared_unqualified" } }));
  const checks = { same: canon({ t: back.text, c: back.calls, s: back.structured }) === canon({ t: live.text, c: live.calls, s: live.structured }), syntheticUsage: back.receipt.usage.inputTokens === 11 && back.receipt.usage.source === "synthetic_replay", operatorRefused: code(op) === "invalid_request" };
  return { pass: Object.values(checks).every(Boolean), actual: checks };
});
await probe("No credential leakage: fixture secret absent from every typed error (message/stack/JSON/inspect) and every receipt across this battery", "0 occurrences in all captured serializations", async () => {
  const hits = leakSink.filter((x) => typeof x === "string" && x.includes(SECRET)).length;
  return { pass: hits === 0 && leakSink.length > 50, actual: { serializationsChecked: leakSink.length, occurrences: hits } };
});
console.log("QA88_RESULTS " + JSON.stringify(results));
process.exit(0);

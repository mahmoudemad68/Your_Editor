# US-107 hosted LLM tool-calling spike

This directory measures tool calls from hosted LLM APIs. It does not edit video, start a local model, or implement the production provider ports from US-301.

Dry-run is the default. The agent that added this package did not make a paid request.

## Providers

| Id        | Environment variable                         | API recorded on 2026-10-02                                                                           |
| --------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| openai    | `OPENAI_API_KEY`                             | Chat Completions. `max_completion_tokens` is 800. Responses-only models are unsupported.             |
| anthropic | `ANTHROPIC_API_KEY`                          | Messages API, `anthropic-version: 2023-06-01`. `max_tokens` is 800.                                  |
| gemini    | `GEMINI_API_KEY`                             | Interactions API. `generation_config.max_output_tokens` is 800.                                      |
| qwen      | `DASHSCOPE_API_KEY` and `DASHSCOPE_BASE_URL` | Allowlisted DashScope OpenAI-compatible chat completions. `max_tokens` is 800.                       |
| deepseek  | `DEEPSEEK_API_KEY`                           | `https://api.deepseek.com/chat/completions`. `max_tokens` is 800. Thinking is omitted, not disabled. |

Pass `--model` yourself. Example names that appeared in those guides (`gpt-5.6-terra`, `gemini-3.8-flash`, `qwen3.8-max`, `deepseek-flash`) are not selected automatically. Add another hosted provider by registering an adapter in `adapters.registry`. If that adapter cannot set a supported output-token limit equal to the 800-token budget, the live call is `BLOCKED` and is not sent.

Thinking mode is not one shared boolean. Qwen explicitly sends `enable_thinking: false`. For `gpt-5.6` and `gpt-5.6-sol`, this benchmark sends `reasoning_effort: "none"` with the function tools. The migrate-to-Responses guide, accessed 2026-10-02, says that starting with GPT-5.4, Chat Completions does not support tool calling with any other `reasoning_effort`. The Sol model card still documents `medium` as the default when the field is omitted. That default is recorded as the omitted default, not as the value sent. DeepSeek omits `thinking` and `reasoning_effort`, so the Chat Completions reference's omitted defaults remain thinking `enabled` and effort `high`. The same reference says `tool_choice: "auto"` is allowed in thinking mode, and this request sends `auto`. `required` and a named tool are not. Both requests send an output cap of 800. A `finish_reason` of `length` is truncated and is not a CP1 success. None of the documented defaults were observed in a live response. Anthropic and Gemini requests do not send a thinking parameter, and no omitted default is recorded for them.

## Scoring

`requests.json` has ten primary requests. Every one expects a tool call. `guardrails.json` keeps two abstention scenarios, `ambiguous-request` and `out-of-bounds-trim`. Those two are not part of the CP1 ten.

Schema-valid tool calls, semantic correctness, and correct abstention stay separate. A call can match the JSON Schema and still be the wrong edit.

An empty tool-call list is not a schema-valid tool call. It is a correct abstention only when that request's expected mode is `no_calls`. The CP1 numerator counts schema-valid tool calls on the ten primary requests. The denominator is 10. The threshold is 9. Abstentions do not add to the numerator. Failed, skipped, and missing requests are not successes. `formal_cp1` stays `NOT_VERIFIED` unless a real live run, not a mock transport, actually sends all ten primary requests. This repository checkout does not do that.

`fixtures/transcript_10min.txt` is 1,500 synthetic words standing in for 600 seconds. It is not customer media. Including that transcript in the prompt, receiving a successful response, and verifying context-window capacity are three different facts. The report uses `FITS` or `EXCEEDS` only when the provider reports input tokens and `context_windows.json` has a documented limit for that exact model id, with `source_url` and `accessed`. Otherwise the status is `UNVERIFIED` and the reason says which fact was missing. Do not invent a limit.

## Local spend cap

`LLM_BENCHMARK_SPEND_CAP_USD` defaults to 1. It must be a finite number greater than or equal to zero. `NaN`, infinity, and negative values stop the run with `BLOCKED_BUDGET` before any request.

This cap is a local admission control. It is not a ceiling on the provider's invoice. The process cannot see the provider's bill.

Before a live request is sent, the runner:

1. Requires a price row at `provider:model` with finite positive `input_per_million_usd` and `output_per_million_usd`, plus `accessed` as `YYYY-MM-DD`. Zero, negative, non-numeric, and undated rows are `BLOCKED_COST`.
2. Estimates input tokens from the full JSON body, including tool definitions and the transcript, as `len(json) / 4`.
3. Adds the 800 output tokens that the provider request itself caps, using that provider's documented field.
4. Reserves `input_estimate * input_price + 800 * output_price` before the network call.

If the reservation would exceed the remaining local cap, the request is `SKIPPED` and not sent. A failed, timed-out, or unreadable response keeps the reservation. Missing output usage is not treated as zero output; the reservation stays. A nonempty request that reports zero input tokens and zero output tokens is an untrusted usage anomaly: the reservation stays, the record says so, and later requests stop. Negative, non-integer, or non-finite token counts are rejected the same way. When both counts are usable and not that zero pair, the ledger replaces the reservation with the priced usage, including Gemini `total_thought_tokens` when that field is present. The accumulated local cost is not allowed to go below zero. If it would, the reservation stays and later requests stop.

Gemini usage is read from `total_input_tokens` and `total_output_tokens`. The older `input_tokens` and `output_tokens` names on an Interactions payload are not used.

## Credentials and DashScope hosts

API keys are read from the environment at runtime. Do not commit them. The runner keeps an explicit list of those values and redacts them from nested report fields, including tool names, arguments, reasons, and the final JSON file. Authorization headers and request bodies are not written to the report or the console.

`DASHSCOPE_BASE_URL` is checked before a bearer token is attached. The allowlist is the pay-as-you-go OpenAI-compatible hosts on the Model Studio base URL page accessed 2026-10-02 (`https://www.alibabacloud.com/help/en/model-studio/base-url`): the shared DashScope hosts, `{WorkspaceId}.{region}.maas.aliyuncs.com` for the documented regions, and the documented trial hosts. The path must be `/compatible-mode/v1`. Userinfo, custom ports, IP addresses, localhost, other domains, and other paths are rejected. Token Plan and Coding Plan hosts are omitted because that page says they are not for backend services. HTTP redirects are not followed, so a `307` cannot carry the credential to another host.

## Commands

Offline tests:

```bash
python3 tools/benchmarks/llm/tests/test_llm_benchmark.py
```

Dry-run, which writes a report and does not use a key:

```bash
python3 tools/benchmarks/llm/runner.py \
  --provider openai \
  --model "$OPENAI_MODEL" \
  --commit-sha "$(git rev-parse HEAD)" \
  --output /tmp/llm-out
```

## Prepared live comparison

Status: **LIVE_READY_PENDING_AUTHORIZATION**. Do not put API keys in the repository, the pull request, logs, or an agent transcript. Export them only in the shell that will run the command.

The first pair is OpenAI and DeepSeek. Both match this adapter's Chat Completions tool calls. Prices and context limits copied on 2026-10-02:

| Provider | Model id                                                                       | Input / 1M | Output / 1M | Context tokens | Source                                                                                                |
| -------- | ------------------------------------------------------------------------------ | ---------- | ----------- | -------------- | ----------------------------------------------------------------------------------------------------- |
| openai   | `gpt-5.6-sol` (the explicit Sol id; the `gpt-5.6` alias is not the live model) | 4          | 20          | 1050000        | https://developers.openai.com/api/docs/models/gpt-5.6-sol                                             |
| deepseek | `deepseek-flash`                                                               | 0.3        | 1.2         | 1000000        | https://api-docs.deepseek.com/quick_start/pricing and https://api-docs.deepseek.com/guides/tool_calls |

DeepSeek's row is the peak cache-miss input rate and the peak output rate. Off-peak is half, and a cache hit is cheaper. OpenAI's row is the standard text rate on the Sol card. That card says the promotional price lasts at least through 2026-11-21. Prompts over 272000 input tokens are priced higher; this transcript is not in that band. GPT-6 Astra still requires the Responses API for tool calling and stays unsupported here. `gpt-5.6-sol` requests send `reasoning_effort: "none"` because Chat Completions function tools do not support the omitted `medium` default. The `gpt-5.6` alias is kept in the price and context files, and it is not the model this live command calls. `deepseek-flash` still omits the thinking fields, so the documented default stays enabled at effort `high`, and the body sends `tool_choice: "auto"` plus `max_tokens` 800. Those defaults are documentation, not a live measurement.

See the reservation before any paid call. This dry-run does not use a key:

```bash
python3 tools/benchmarks/llm/runner.py \
  --provider openai \
  --model gpt-5.6-sol \
  --commit-sha "$(git rev-parse HEAD)" \
  --output /tmp/llm-out
python3 tools/benchmarks/llm/runner.py \
  --provider deepseek \
  --model deepseek-flash \
  --commit-sha "$(git rev-parse HEAD)" \
  --output /tmp/llm-out
```

Read `maximum_local_reservation_usd` in each JSON file. The default local cap is 1 USD. If that sum is greater than the cap, raise `LLM_BENCHMARK_SPEND_CAP_USD` in the shell before `--live`, or the later requests are skipped and formal CP1 stays `NOT_VERIFIED`.

When you authorize a live run, export the key in that shell and add `--live`:

```bash
export OPENAI_API_KEY
python3 tools/benchmarks/llm/runner.py \
  --provider openai \
  --model gpt-5.6-sol \
  --live \
  --commit-sha "$(git rev-parse HEAD)" \
  --output /tmp/llm-out

export DEEPSEEK_API_KEY
python3 tools/benchmarks/llm/runner.py \
  --provider deepseek \
  --model deepseek-flash \
  --live \
  --commit-sha "$(git rev-parse HEAD)" \
  --output /tmp/llm-out
```

Each file reports schema-valid tool calls out of 10, semantic correctness, guardrail abstentions, median latency, tokens, reserved and charged cost, and context-window fit. Formal CP1 in that file becomes PASS or FAIL only when the live transport sent all ten primary requests. Two such files are the minimum comparison. They do not by themselves accept US-107.

## Adding another provider later

Set the matching variable and pass that provider id:

- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`
- `DASHSCOPE_API_KEY` and an allowlisted `DASHSCOPE_BASE_URL`
- `DEEPSEEK_API_KEY`

Use the same `--live`, `--model`, price key (`anthropic:<model>`, and so on), and local spend cap. A provider that has not been run stays pending. A comparison that names a default needs live measurements from at least two hosted providers. The research record stays `NOT_VERIFIED` until a person reviews those live files.

## Results template

`results/*.json` is gitignored. A dry-run file looks like:

```json
{
  "commit_sha": "<git sha>",
  "provider": "openai",
  "model": "<the model you passed>",
  "live": false,
  "spend_cap_note": "Local reservation before send. Not a provider-side invoice ceiling.",
  "summary": {
    "live_requests": 0,
    "schema_valid_tool_calls": null,
    "correct_abstentions": 0,
    "semantic_correct": null,
    "median_latency_seconds": null,
    "cp1_schema": {
      "denominator": 10,
      "threshold": 9,
      "observed_pass": null
    },
    "observed_cp1_schema": null,
    "formal_cp1": "NOT_VERIFIED",
    "measurements": "PENDING"
  },
  "records": []
}
```

A completed live file sets `measurements` to `UNREVIEWED` until the real transport has sent every primary request. Only that case sets `formal_cp1` to PASS or FAIL. It still does not accept US-107. Each record includes `suite` (`primary` or `guardrail`), status (`DRY_RUN`, `PENDING_CREDENTIALS`, `BLOCKED_COST`, `BLOCKED_BUDGET`, `BLOCKED`, `UNSUPPORTED`, `SKIPPED`, `FAILED`, `BUDGET_UNSAFE`, or `SUCCESS`), tool calls, latency, token counts, reserved and charged cost, schema-valid tool calls, correct abstention, semantic correctness, and context-window status.

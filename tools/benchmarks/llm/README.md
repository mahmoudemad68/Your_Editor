# US-107 hosted LLM tool-calling spike

This directory measures tool calls from hosted LLM APIs. It does not edit video, start a local model, or implement the production provider ports from US-301.

Dry-run is the default. The agent that added this package did not make a paid request.

## Providers

| Id        | Environment variable                         | API recorded on 2026-10-02                                                                     |
| --------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| openai    | `OPENAI_API_KEY`                             | Chat Completions. `max_completion_tokens` is 800. Responses-only models are unsupported.       |
| anthropic | `ANTHROPIC_API_KEY`                          | Messages API, `anthropic-version: 2023-06-01`. `max_tokens` is 800.                            |
| gemini    | `GEMINI_API_KEY`                             | Interactions API. `generation_config.max_output_tokens` is 800.                                |
| qwen      | `DASHSCOPE_API_KEY` and `DASHSCOPE_BASE_URL` | Allowlisted DashScope OpenAI-compatible chat completions. `max_tokens` is 800.                 |
| deepseek  | `DEEPSEEK_API_KEY`                           | `https://api.deepseek.com/chat/completions`. `max_tokens` is 800. Strict and thinking are off. |

Pass `--model` yourself. Example names that appeared in those guides (`gpt-5.6-terra`, `gemini-3.8-flash`, `qwen3.8-max`, `deepseek-flash`) are not selected automatically. Add another hosted provider by registering an adapter in `adapters.registry`. If that adapter cannot set a supported output-token limit equal to the 800-token budget, the live call is `BLOCKED` and is not sent.

Thinking mode is not one shared boolean. OpenAI can send `reasoning_effort` only when you add that option in code. Qwen sends `enable_thinking: false`. DeepSeek thinking mode is left off. Anthropic and Gemini requests in this spike do not enable a thinking feature.

## Scoring

`requests.json` has ten scripted requests. Eight expect a tool call. Two (`ambiguous-request` and `out-of-bounds-trim`) expect no call.

Schema-valid tool calls and semantic correctness stay separate. A call can match the JSON Schema and still be the wrong edit.

An empty tool-call list is not a schema-valid tool call. It is a correct abstention only when that request's expected mode is `no_calls`. The CP1 fraction is `valid_outcomes / 10`. A valid outcome is either a schema-valid tool call or a correct abstention. The threshold is 9. Correct abstentions are not renamed as tool calls. `formal_cp1` stays `NOT_VERIFIED` for mocks and for this repository run.

`fixtures/transcript_10min.txt` is 1,500 synthetic words standing in for 600 seconds. It is not customer media. Including that transcript in the prompt, receiving a successful response, and verifying context-window capacity are three different facts. The report uses `FITS` or `EXCEEDS` only when the provider reports input tokens and `context_windows.json` has a documented limit for that exact model id, with `source_url` and `accessed`. Otherwise the status is `UNVERIFIED` and the reason says which fact was missing. Do not invent a limit.

## Local spend cap

`LLM_BENCHMARK_SPEND_CAP_USD` defaults to 1. It must be a finite number greater than or equal to zero. `NaN`, infinity, and negative values stop the run with `BLOCKED_BUDGET` before any request.

This cap is a local admission control. It is not a ceiling on the provider's invoice. The process cannot see the provider's bill.

Before a live request is sent, the runner:

1. Requires a price row at `provider:model` with finite positive `input_per_million_usd` and `output_per_million_usd`, plus `accessed` as `YYYY-MM-DD`. Zero, negative, non-numeric, and undated rows are `BLOCKED_COST`.
2. Estimates input tokens from the full JSON body, including tool definitions and the transcript, as `len(json) / 4`.
3. Adds the 800 output tokens that the provider request itself caps, using that provider's documented field.
4. Reserves `input_estimate * input_price + 800 * output_price` before the network call.

If the reservation would exceed the remaining local cap, the request is `SKIPPED` and not sent. A failed, timed-out, or unreadable response keeps the reservation. Missing output usage is not treated as zero output; the reservation stays. Negative, non-integer, or non-finite token counts are rejected, the reservation stays, and later requests stop. When both input and output counts are usable, the ledger replaces the reservation with the priced usage, including Gemini `total_thought_tokens` when that field is present. The accumulated local cost is not allowed to go below zero. If it would, the reservation stays and later requests stop.

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

## How the owner runs OpenAI first

1. Choose a model id from the current OpenAI function-calling guide and export it as `OPENAI_MODEL`. Do not rely on a name baked into this repo.
2. Add a dated price to `pricing.json` under the key `openai:<that model>` with finite positive `input_per_million_usd` and `output_per_million_usd`. Copy the numbers from OpenAI's pricing page and set `accessed` to that day.
3. Optionally add that same model id to `context_windows.json` with `limit_tokens`, `source_url`, and `accessed` copied from the model card. Leave it out if you do not have the documented limit.
4. Export `OPENAI_API_KEY` in the shell. Do not put it in a file in this repository.
5. Export `LLM_BENCHMARK_SPEND_CAP_USD` if you want a local cap other than the default of 1. Use a finite non-negative number.
6. Run the command above with `--live`.

Without a valid price row, the runner does not call the provider.

## Adding another provider later

Set the matching variable and pass that provider id:

- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`
- `DASHSCOPE_API_KEY` and an allowlisted `DASHSCOPE_BASE_URL`
- `DEEPSEEK_API_KEY`

Use the same `--live`, `--model`, price key (`anthropic:<model>`, and so on), and local spend cap. A provider that has not been run stays pending. A comparison that names a default needs live measurements from at least two hosted providers. Formal CP1 stays `NOT_VERIFIED` until those measurements are reviewed.

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
    "correct_abstentions": null,
    "valid_outcomes": null,
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

A completed live file sets `measurements` to `UNREVIEWED`. That means the process recorded a run. It does not accept US-107 or move formal CP1 to pass. Each record includes status (`DRY_RUN`, `PENDING_CREDENTIALS`, `BLOCKED_COST`, `BLOCKED_BUDGET`, `BLOCKED`, `UNSUPPORTED`, `SKIPPED`, `FAILED`, `BUDGET_UNSAFE`, or `SUCCESS`), tool calls, latency, token counts, reserved and charged cost, schema-valid tool calls, correct abstention, semantic correctness, and context-window status.

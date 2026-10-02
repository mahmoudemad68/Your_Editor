# US-107 hosted LLM tool-calling spike

This directory measures tool calls from hosted LLM APIs. It does not edit video, start a local model, or implement the production provider ports from US-301.

Dry-run is the default. The agent that added this package did not make a paid request.

## Providers

| Id        | Environment variable                         | API recorded on 2026-10-02                                                                        |
| --------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| openai    | `OPENAI_API_KEY`                             | Chat Completions. Responses-only models are unsupported here.                                     |
| anthropic | `ANTHROPIC_API_KEY`                          | Messages API, `anthropic-version: 2023-06-01`.                                                    |
| gemini    | `GEMINI_API_KEY`                             | Interactions API, `v1beta/interactions`.                                                          |
| qwen      | `DASHSCOPE_API_KEY` and `DASHSCOPE_BASE_URL` | OpenAI-compatible chat completions. The host includes a workspace id, so there is no default URL. |
| deepseek  | `DEEPSEEK_API_KEY`                           | `https://api.deepseek.com/chat/completions`. Strict mode and thinking mode are not sent.          |

Pass `--model` yourself. Example names that appeared in those guides (`gpt-5.6-terra`, `gemini-3.8-flash`, `qwen3.8-max`, `deepseek-flash`) are not selected automatically. Add another hosted provider by registering an adapter in `adapters.registry`.

Thinking mode is not one shared boolean. OpenAI can send `reasoning_effort` only when you add that option in code. Qwen sends `enable_thinking: false`. DeepSeek thinking mode is left off. Anthropic and Gemini requests in this spike do not enable a thinking feature.

## Dataset

`requests.json` has ten scripted requests for `trim`, `add_caption`, and `reframe`. Schema checks and the expected edit are separate. `fixtures/transcript_10min.txt` is 1,500 synthetic words standing in for 600 seconds. It is not customer media.

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
2. Add a dated price to `pricing.json` under the key `openai:<that model>` with `input_per_million_usd` and `output_per_million_usd`. Copy the numbers from OpenAI's pricing page and set `accessed` to that day.
3. Export `OPENAI_API_KEY` in the shell. Do not put it in a file in this repository.
4. Export `LLM_BENCHMARK_SPEND_CAP_USD` if you want a cap other than the default of 1.
5. Run the command above with `--live`.

The runner refuses the call when the price row is missing, because it cannot enforce the cap. Before each of the ten requests it estimates input tokens as `len(prompt) // 4` and output tokens as 800, multiplies by the dated prices, and skips the request when that upper bound would exceed the remaining cap. After a successful response it adds the cost from reported token counts when the provider sends them.

## Adding another provider later

Set the matching variable and pass that provider id:

- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`
- `DASHSCOPE_API_KEY` and `DASHSCOPE_BASE_URL`
- `DEEPSEEK_API_KEY`

Use the same `--live`, `--model`, price key (`anthropic:<model>`, and so on), and spend cap. A provider that has not been run stays `PENDING`. A comparison that names a default needs live measurements from at least two hosted providers. Formal CP1 stays `NOT_VERIFIED` until those measurements are reviewed. The threshold is at least 9 of 10 schema-valid calls. Semantic misses do not count toward that 9.

## Results template

`results/*.json` is gitignored. A live or dry-run file looks like:

```json
{
  "commit_sha": "<git sha>",
  "provider": "openai",
  "model": "<the model you passed>",
  "live": false,
  "summary": {
    "live_requests": 0,
    "schema_valid": null,
    "semantic_correct": null,
    "median_latency_seconds": null,
    "observed_cp1_schema": null,
    "formal_cp1": "NOT_VERIFIED",
    "measurements": "PENDING"
  },
  "records": []
}
```

Each record includes status (`DRY_RUN`, `PENDING_CREDENTIALS`, `BLOCKED_COST`, `UNSUPPORTED`, `SKIPPED`, `FAILED`, or `SUCCESS`), tool calls, latency, token counts, estimated cost, schema validity, and semantic correctness. Credentials are redacted from error strings.

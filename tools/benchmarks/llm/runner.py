"""Dry-run by default. Live calls need --live, a key, a price row, and a spend cap."""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path
from typing import Any

from adapters import post_json, redact, registry
from scoring import score_case
from transcript import DURATION_SECONDS, load_transcript

DEFAULT_CAP_USD = 1.0
MAX_OUTPUT_TOKENS = 800
ENV_NAMES = (
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "DASHSCOPE_API_KEY",
    "DEEPSEEK_API_KEY",
    "DASHSCOPE_BASE_URL",
)


def estimate_tokens(text: str) -> int:
    return max(1, (len(text) + 3) // 4)


def load_pricing(path: Path) -> dict[str, Any]:
    document = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(document, dict) or not isinstance(document.get("models"), dict):
        raise TypeError("pricing.json must contain a models object")
    return document


def estimate_cost_usd(
    pricing: dict[str, Any],
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
) -> float | None:
    row = pricing["models"].get(f"{provider}:{model}")
    if not isinstance(row, dict):
        return None
    input_price = row.get("input_per_million_usd")
    output_price = row.get("output_per_million_usd")
    if not isinstance(input_price, (int, float)) or not isinstance(
        output_price, (int, float)
    ):
        return None
    return (input_tokens / 1_000_000) * float(input_price) + (
        output_tokens / 1_000_000
    ) * float(output_price)


def load_requests(path: Path) -> list[dict[str, Any]]:
    document = json.loads(path.read_text(encoding="utf-8"))
    requests = document["requests"]
    if not isinstance(requests, list) or len(requests) != 10:
        raise ValueError("the benchmark dataset must contain 10 requests")
    return requests


def prompt_for(case: dict[str, Any], transcript: str) -> str:
    return (
        "The source video is 600 seconds. Call only trim, add_caption, or reframe. "
        "Do not run shell commands.\n"
        f"Request: {case['prompt']}\n"
        f"Transcript:\n{transcript}"
    )


def thinking_metadata(provider: str, request_body: dict[str, Any]) -> dict[str, Any]:
    if provider == "openai":
        effort = request_body.get("reasoning_effort")
        return {
            "control": "openai reasoning_effort",
            "requested": effort,
            "applied": effort is not None,
            "unsupported_as_universal_boolean": True,
        }
    if provider == "qwen":
        return {
            "control": "qwen enable_thinking",
            "requested": request_body.get("enable_thinking"),
            "applied": "enable_thinking" in request_body,
            "unsupported_as_universal_boolean": True,
        }
    if provider == "deepseek":
        return {
            "control": "deepseek thinking mode",
            "requested": None,
            "applied": False,
            "note": "Thinking mode is a separate DeepSeek-V3.2 setting and is not sent.",
            "unsupported_as_universal_boolean": True,
        }
    return {
        "control": None,
        "requested": None,
        "applied": False,
        "unsupported_as_universal_boolean": True,
    }


def _result(
    provider: str,
    model: str,
    case_id: str,
    status: str,
    reason: str | None,
    calls: list[dict[str, Any]] | None = None,
    **extra: Any,
) -> dict[str, Any]:
    payload = {
        "provider": provider,
        "model": model,
        "request_id": case_id,
        "status": status,
        "reason": reason,
        "calls": calls or [],
        "latency_seconds": None,
        "input_tokens": None,
        "output_tokens": None,
        "estimated_cost_usd": None,
        "schema_valid": None,
        "semantic_correct": None,
        "context_window": "UNKNOWN",
    }
    payload.update(extra)
    return payload


def run_case(
    provider: str,
    model: str,
    case: dict[str, Any],
    transcript: str,
    live: bool,
    api_key: str,
    options: dict[str, Any],
    pricing: dict[str, Any],
    spent_usd: float,
    cap_usd: float,
    commit_sha: str,
    transport: Any = None,
    timeout: float = 60,
) -> dict[str, Any]:
    adapters = registry()
    if provider not in adapters:
        raise KeyError(provider)
    adapter = adapters[provider]
    if not model.strip():
        return _result(
            provider,
            model,
            case["id"],
            "MISSING_MODEL",
            "pass --model for this provider",
        )
    prompt = prompt_for(case, transcript)
    body = adapter.build_request(model, prompt, options)
    thinking = thinking_metadata(provider, body if isinstance(body, dict) else {})
    secrets = [api_key, *[str(options.get(name, "")) for name in ENV_NAMES]]
    if body.get("unsupported"):
        return _result(
            provider,
            model,
            case["id"],
            "UNSUPPORTED",
            redact(str(body.get("reason")), secrets),
            thinking=thinking,
            commit_sha=commit_sha,
        )
    if not live:
        return _result(
            provider,
            model,
            case["id"],
            "DRY_RUN",
            "live calls are off",
            thinking=thinking,
            commit_sha=commit_sha,
            request_preview=_preview(body),
        )
    if not api_key:
        return _result(
            provider,
            model,
            case["id"],
            "PENDING_CREDENTIALS",
            f"{adapter.env_var} is not set",
            thinking=thinking,
            commit_sha=commit_sha,
        )
    input_tokens = estimate_tokens(prompt)
    upper = estimate_cost_usd(pricing, provider, model, input_tokens, MAX_OUTPUT_TOKENS)
    if upper is None:
        return _result(
            provider,
            model,
            case["id"],
            "BLOCKED_COST",
            "no dated price for this model, so the spend cap cannot be enforced",
            thinking=thinking,
            commit_sha=commit_sha,
        )
    if spent_usd + upper > cap_usd:
        return _result(
            provider,
            model,
            case["id"],
            "SKIPPED",
            "spending cap would be exceeded",
            thinking=thinking,
            commit_sha=commit_sha,
            estimated_cost_usd=upper,
        )
    url = adapter.request_url(options)
    headers = _headers(provider, api_key)
    started = time.perf_counter()
    try:
        if transport is None:
            payload = post_json(url, headers, body, timeout)
        else:
            payload = transport(url, headers, body)
    except Exception as exc:  # noqa: BLE001
        # Provider libraries and urllib raise many types. The key must not leak.
        return _result(
            provider,
            model,
            case["id"],
            "FAILED",
            redact(str(exc), secrets),
            thinking=thinking,
            commit_sha=commit_sha,
            latency_seconds=time.perf_counter() - started,
        )
    latency = time.perf_counter() - started
    parsed = adapter.parse_response(payload if isinstance(payload, dict) else {})
    calls = parsed["calls"]
    if parsed["parse_error"]:
        return _result(
            provider,
            model,
            case["id"],
            "FAILED",
            parsed["parse_error"],
            calls=calls,
            thinking=thinking,
            commit_sha=commit_sha,
            latency_seconds=latency,
        )
    scores = score_case(case, calls)
    actual_in = (
        parsed["input_tokens"]
        if isinstance(parsed["input_tokens"], int)
        else input_tokens
    )
    actual_out = (
        parsed["output_tokens"] if isinstance(parsed["output_tokens"], int) else 0
    )
    cost = estimate_cost_usd(pricing, provider, model, actual_in, actual_out)
    return _result(
        provider,
        model,
        case["id"],
        "SUCCESS",
        None,
        calls=calls,
        thinking=thinking,
        commit_sha=commit_sha,
        latency_seconds=latency,
        input_tokens=parsed["input_tokens"],
        output_tokens=parsed["output_tokens"],
        estimated_cost_usd=cost,
        schema_valid=scores["schema_valid"],
        semantic_correct=scores["semantic_correct"],
        context_window="UNKNOWN",
        context_input_tokens_estimate=input_tokens,
        transcript_seconds=DURATION_SECONDS,
    )


def _headers(provider: str, api_key: str) -> dict[str, str]:
    if provider == "anthropic":
        return {
            "content-type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        }
    if provider == "gemini":
        return {"content-type": "application/json", "x-goog-api-key": api_key}
    return {"content-type": "application/json", "authorization": f"Bearer {api_key}"}


def _preview(body: dict[str, Any]) -> dict[str, Any]:
    preview = {key: body[key] for key in body if key != "messages" and key != "input"}
    preview["prompt_included"] = "messages" in body or "input" in body
    return preview


def summarize(records: list[dict[str, Any]]) -> dict[str, Any]:
    live = [record for record in records if record["status"] == "SUCCESS"]
    latencies = sorted(
        float(record["latency_seconds"])
        for record in live
        if isinstance(record.get("latency_seconds"), (int, float))
    )
    median = None
    if latencies:
        middle = len(latencies) // 2
        median = (
            latencies[middle]
            if len(latencies) % 2
            else (latencies[middle - 1] + latencies[middle]) / 2
        )
    schema_hits = sum(1 for record in live if record.get("schema_valid") is True)
    semantic_hits = sum(1 for record in live if record.get("semantic_correct") is True)
    observed = None
    if len(live) == 10:
        observed = schema_hits >= 9
    return {
        "live_requests": len(live),
        "schema_valid": schema_hits if live else None,
        "semantic_correct": semantic_hits if live else None,
        "median_latency_seconds": median,
        "observed_cp1_schema": observed,
        "formal_cp1": "NOT_VERIFIED",
        "measurements": "PENDING" if not live else "LIVE",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="US-107 hosted tool-calling benchmark")
    parser.add_argument("--provider", required=True, choices=sorted(registry()))
    parser.add_argument("--model", default="")
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--commit-sha", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--spend-cap-usd", type=float, default=None)
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parent
    cases = load_requests(root / "requests.json")
    pricing = load_pricing(root / "pricing.json")
    transcript = load_transcript()
    adapter = registry()[args.provider]
    api_key = os.environ.get(adapter.env_var, "")
    cap = args.spend_cap_usd
    if cap is None:
        cap = float(os.environ.get("LLM_BENCHMARK_SPEND_CAP_USD", DEFAULT_CAP_USD))
    options = {"dashscope_base_url": os.environ.get("DASHSCOPE_BASE_URL", "")}
    if args.live and api_key:
        print(
            "Live mode was requested. This process will call the provider if the price cap allows it."
        )
    spent = 0.0
    records = []
    for case in cases:
        record = run_case(
            args.provider,
            args.model,
            case,
            transcript,
            args.live,
            api_key,
            options,
            pricing,
            spent,
            cap,
            args.commit_sha,
        )
        cost = record.get("estimated_cost_usd")
        if (
            args.live
            and record["status"] == "SUCCESS"
            and isinstance(cost, (int, float))
        ):
            spent += float(cost)
        records.append(record)
    args.output.mkdir(parents=True, exist_ok=True)
    report = {
        "commit_sha": args.commit_sha,
        "provider": args.provider,
        "model": args.model,
        "live": args.live,
        "summary": summarize(records),
        "documentation": adapter.documentation(),
        "records": records,
    }
    destination = args.output / f"{args.provider}.json"
    destination.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

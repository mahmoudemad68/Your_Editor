"""Dry-run by default. Live calls need --live, a key, a dated positive price, and a valid cap.

The spend cap is a local admission control. This process reserves the estimated
cost of each request before sending it. That is not a guarantee of the
provider's invoice.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import time
from datetime import date
from pathlib import Path
from typing import Any

from adapters import (
    MAX_OUTPUT_TOKENS,
    collect_secrets,
    dumps_redacted,
    ensure_transport_url,
    post_json,
    redact,
    registry,
    sanitize,
)
from provider_docs import (
    ACCESSED,
    PROVIDERS,
    documented_deepseek_thinking_default,
    documented_openai_reasoning_default,
)
from scoring import score_case
from transcript import DURATION_SECONDS, load_transcript

DEFAULT_CAP_USD = 1.0
CP1_DENOMINATOR = 10
CP1_THRESHOLD = 9
SECRET_ENV_NAMES = (
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "DASHSCOPE_API_KEY",
    "DEEPSEEK_API_KEY",
)


def estimate_tokens(text: str) -> int:
    return max(1, (len(text) + 3) // 4)


def estimate_request_tokens(body: dict[str, Any]) -> int:
    """Token estimate for the full submitted body, including tool definitions."""

    encoded = json.dumps(
        body, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    )
    return estimate_tokens(encoded)


def load_pricing(path: Path) -> dict[str, Any]:
    document = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(document, dict) or not isinstance(document.get("models"), dict):
        raise TypeError("pricing.json must contain a models object")
    return document


def load_context_limits(path: Path) -> dict[str, dict[str, Any]]:
    if not path.is_file():
        return {}
    document = json.loads(path.read_text(encoding="utf-8"))
    models = document.get("models") if isinstance(document, dict) else None
    if not isinstance(models, dict):
        return {}
    accepted: dict[str, dict[str, Any]] = {}
    for model, row in models.items():
        if isinstance(model, str) and _valid_context_row(row):
            accepted[model] = row
    return accepted


def _valid_context_row(row: object) -> bool:
    if not isinstance(row, dict):
        return False
    limit = row.get("limit_tokens")
    source = row.get("source_url")
    if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
        return False
    if not isinstance(source, str) or not source.startswith("https://"):
        return False
    return _valid_date(row.get("accessed"))


def _valid_date(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return False
    return parsed.isoformat() == value


def _positive_finite(value: object) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(value) and float(value) > 0


def cap_is_valid(value: object) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(value) and float(value) >= 0


def priced_rates(
    pricing: dict[str, Any], provider: str, model: str
) -> tuple[float, float] | None:
    models = pricing.get("models")
    if not isinstance(models, dict):
        return None
    row = models.get(f"{provider}:{model}")
    if not isinstance(row, dict) or not _valid_date(row.get("accessed")):
        return None
    input_price = row.get("input_per_million_usd")
    output_price = row.get("output_per_million_usd")
    if not _positive_finite(input_price) or not _positive_finite(output_price):
        return None
    return float(input_price), float(output_price)


def estimate_cost_usd(
    rates: tuple[float, float], input_tokens: int, output_tokens: int
) -> float | None:
    if isinstance(input_tokens, bool) or isinstance(output_tokens, bool):
        return None
    if not isinstance(input_tokens, int) or not isinstance(output_tokens, int):
        return None
    if input_tokens < 0 or output_tokens < 0:
        return None
    cost = (input_tokens / 1_000_000) * rates[0] + (output_tokens / 1_000_000) * rates[
        1
    ]
    if not math.isfinite(cost) or cost < 0:
        return None
    return cost


def load_requests(path: Path) -> list[dict[str, Any]]:
    document = json.loads(path.read_text(encoding="utf-8"))
    requests = document["requests"]
    if not isinstance(requests, list) or len(requests) != CP1_DENOMINATOR:
        raise ValueError("the primary benchmark dataset must contain 10 requests")
    for row in requests:
        if row.get("expected", {}).get("mode") != "calls":
            raise ValueError("primary requests must expect tool calls")
    return requests


def load_guardrails(path: Path) -> list[dict[str, Any]]:
    document = json.loads(path.read_text(encoding="utf-8"))
    requests = document["requests"]
    if not isinstance(requests, list) or len(requests) != 2:
        raise ValueError("the abstention guardrails must contain 2 requests")
    for row in requests:
        if row.get("expected", {}).get("mode") != "no_calls":
            raise ValueError("guardrail requests must expect no tool calls")
    return requests


def load_benchmark(root: Path) -> list[dict[str, Any]]:
    """Ten primary tool-call requests, then the abstention guardrails."""

    primary = load_requests(root / "requests.json")
    guardrails = load_guardrails(root / "guardrails.json")
    cases: list[dict[str, Any]] = []
    for row in primary:
        stamped = dict(row)
        stamped["suite"] = "primary"
        cases.append(stamped)
    for row in guardrails:
        stamped = dict(row)
        stamped["suite"] = "guardrail"
        cases.append(stamped)
    return cases


SENT_STATUSES = frozenset({"SUCCESS", "FAILED", "BUDGET_UNSAFE"})


def cp1_formal_status(
    *,
    live: bool,
    real_transport: bool,
    all_primary_sent: bool,
    observed_pass: bool | None,
) -> str:
    """PASS or FAIL only for a real live measurement of all ten primary requests."""

    if live and real_transport and all_primary_sent and observed_pass is not None:
        return "PASS" if observed_pass else "FAIL"
    return "NOT_VERIFIED"


def prompt_for(case: dict[str, Any], transcript: str) -> str:
    return (
        "The source video is 600 seconds. Call only trim, add_caption, or reframe. "
        "Do not run shell commands.\n"
        f"Request: {case['prompt']}\n"
        f"Transcript:\n{transcript}"
    )


def _sent_output_cap(provider: str, body: dict[str, Any]) -> tuple[str | None, object]:
    if provider == "openai":
        return "max_completion_tokens", body.get("max_completion_tokens")
    if provider == "gemini":
        config = body.get("generation_config")
        if isinstance(config, dict):
            return "generation_config.max_output_tokens", config.get(
                "max_output_tokens"
            )
        return "generation_config.max_output_tokens", None
    if provider in {"anthropic", "qwen", "deepseek"}:
        return "max_tokens", body.get("max_tokens")
    return None, None


def _thinking_base(provider: str, body: dict[str, Any]) -> dict[str, Any]:
    field, cap = _sent_output_cap(provider, body)
    return {
        "unsupported_as_universal_boolean": True,
        "empirically_observed": False,
        "output_token_cap": cap,
        "output_token_cap_field": field,
        "output_token_cap_source": "request_body",
    }


def thinking_metadata(provider: str, request_body: dict[str, Any]) -> dict[str, Any]:
    """Separate an explicit request field from a documented omitted default.

    A documented default is copied from the provider page. It is not a value
    this process observed in a live response.
    """

    model = str(request_body.get("model") or "")
    base = _thinking_base(provider, request_body)
    if provider == "openai":
        sent = "reasoning_effort" in request_body
        effort = request_body.get("reasoning_effort") if sent else None
        documented = None if sent else documented_openai_reasoning_default(model)
        catalog = PROVIDERS["openai"].get("thinking_default")
        source = catalog.get("source_url") if isinstance(catalog, dict) else None
        constraint_source = (
            catalog.get("tool_constraint_source") if isinstance(catalog, dict) else None
        )
        metadata = {
            **base,
            "control": "openai reasoning_effort",
            "explicitly_requested": effort,
            "parameter_omitted": not sent,
            "documented_default": documented,
            "documented_default_source": source if documented is not None else None,
            "documented_default_accessed": ACCESSED if documented is not None else None,
        }
        if not sent and documented is None:
            metadata["documented_default_reason"] = (
                "no documented omitted default is recorded for this model"
            )
        if not sent and documented == "medium" and request_body.get("tools"):
            metadata["documented_tool_constraint"] = {
                "statement": (
                    "The GPT-5.6 upgrade guide says Chat Completions function "
                    "tools are compatible only with effective reasoning none."
                ),
                "source_url": constraint_source,
                "accessed": ACCESSED,
                "empirically_observed": False,
                "request_unchanged": True,
            }
        return metadata
    if provider == "qwen":
        sent = "enable_thinking" in request_body
        return {
            **base,
            "control": "qwen enable_thinking",
            "explicitly_requested": request_body.get("enable_thinking")
            if sent
            else None,
            "parameter_omitted": not sent,
            "documented_default": None,
            "documented_default_source": None,
            "documented_default_accessed": None,
        }
    if provider == "deepseek":
        thinking_sent = "thinking" in request_body
        effort_sent = "reasoning_effort" in request_body
        omitted = not thinking_sent and not effort_sent
        documented = documented_deepseek_thinking_default(model) if omitted else None
        catalog = PROVIDERS["deepseek"].get("thinking_default")
        source = catalog.get("source_url") if isinstance(catalog, dict) else None
        metadata = {
            **base,
            "control": "deepseek thinking and reasoning_effort",
            "explicitly_requested": None
            if omitted
            else {
                "thinking": request_body.get("thinking") if thinking_sent else None,
                "reasoning_effort": request_body.get("reasoning_effort")
                if effort_sent
                else None,
            },
            "parameter_omitted": omitted,
            "documented_default": documented,
            "documented_default_source": source if documented is not None else None,
            "documented_default_accessed": ACCESSED if documented is not None else None,
        }
        if omitted and documented is None:
            metadata["documented_default_reason"] = (
                "no documented omitted default is recorded for this model"
            )
        return metadata
    return {
        **base,
        "control": None,
        "explicitly_requested": None,
        "parameter_omitted": True,
        "documented_default": None,
        "documented_default_source": None,
        "documented_default_accessed": None,
        "documented_default_reason": "no documented omitted default is recorded for this provider",
    }


def _classify_token(value: object) -> tuple[str, int | None]:
    if value is None:
        return "missing", None
    if isinstance(value, bool) or not isinstance(value, int):
        return "invalid", None
    if value < 0:
        return "invalid", None
    return "ok", value


def _result(
    provider: str,
    model: str,
    case_id: str,
    status: str,
    reason: str | None,
    calls: list[dict[str, Any]] | None = None,
    spent_usd: float = 0.0,
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
        "budget_reserved_usd": 0.0,
        "budget_charged_usd": 0.0,
        "running_spent_usd": spent_usd,
        "stop_subsequent": False,
        "usage_status": "not_sent",
        "schema_valid": None,
        "schema_valid_tool_call": None,
        "correct_abstention": None,
        "valid_outcome": None,
        "semantic_correct": None,
        "transcript_included": False,
        "transcript_kind": None,
        "request_processed": False,
        "context_window": "UNVERIFIED",
        "context_window_reason": "not evaluated",
        "context_input_tokens": None,
        "context_limit_tokens": None,
    }
    payload.update(extra)
    return payload


def assess_context(
    model: str,
    reported_input: int | None,
    limits: dict[str, dict[str, Any]],
    *,
    sent: bool,
) -> dict[str, Any]:
    """Compare reported input usage with a documented limit. Do not invent one."""

    row = limits.get(model)
    limit = (
        int(row["limit_tokens"])
        if row is not None and _valid_context_row(row)
        else None
    )
    if not sent:
        return {
            "context_window": "UNVERIFIED",
            "context_window_reason": "request was not sent, so provider input usage is unavailable",
            "context_input_tokens": None,
            "context_limit_tokens": limit,
        }
    if reported_input is None:
        return {
            "context_window": "UNVERIFIED",
            "context_window_reason": "provider did not report a usable input token count",
            "context_input_tokens": None,
            "context_limit_tokens": limit,
        }
    if limit is None:
        return {
            "context_window": "UNVERIFIED",
            "context_window_reason": "no documented context-window limit is recorded for this model",
            "context_input_tokens": reported_input,
            "context_limit_tokens": None,
        }
    if reported_input <= limit:
        state = "FITS"
        reason = "reported input tokens are within the documented context limit"
    else:
        state = "EXCEEDS"
        reason = "reported input tokens exceed the documented context limit"
    return {
        "context_window": state,
        "context_window_reason": reason,
        "context_input_tokens": reported_input,
        "context_limit_tokens": limit,
    }


def _transcript_fields(included: bool) -> dict[str, Any]:
    if not included:
        return {"transcript_included": False, "transcript_kind": None}
    return {
        "transcript_included": True,
        "transcript_kind": "synthetic",
        "transcript_seconds": DURATION_SECONDS,
    }


def _exceeds(spent: float, cap: float) -> bool:
    return spent > cap + 1e-9


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
    context_limits: dict[str, dict[str, Any]] | None = None,
    secrets: list[str] | None = None,
) -> dict[str, Any]:
    adapters = registry()
    if provider not in adapters:
        raise KeyError(provider)
    adapter = adapters[provider]
    limits = context_limits or {}
    known = secrets if secrets is not None else _secrets(api_key, options)
    if not model.strip():
        return _finish(
            _result(
                provider,
                model,
                case["id"],
                "MISSING_MODEL",
                "pass --model for this provider",
                spent_usd=spent_usd,
            ),
            known,
        )
    if not cap_is_valid(cap_usd) or not cap_is_valid(spent_usd):
        return _finish(
            _result(
                provider,
                model,
                case["id"],
                "BLOCKED_BUDGET",
                "spending cap must be a finite number greater than or equal to zero",
                spent_usd=0.0,
                stop_subsequent=True,
            ),
            known,
        )
    prompt = prompt_for(case, transcript)
    body = adapter.build_request(model, prompt, options)
    thinking = thinking_metadata(provider, body if isinstance(body, dict) else {})
    common = {
        "thinking": thinking,
        "commit_sha": commit_sha,
        "spent_usd": spent_usd,
        **_transcript_fields(True),
    }
    if body.get("unsupported"):
        return _finish(
            _result(
                provider,
                model,
                case["id"],
                "UNSUPPORTED",
                redact(str(body.get("reason")), known),
                **common,
                **assess_context(model, None, limits, sent=False),
            ),
            known,
        )
    if body.get("blocked"):
        return _finish(
            _result(
                provider,
                model,
                case["id"],
                "BLOCKED",
                redact(str(body.get("reason")), known),
                **common,
                stop_subsequent=True,
                **assess_context(model, None, limits, sent=False),
            ),
            known,
        )
    if not live:
        return _finish(
            _result(
                provider,
                model,
                case["id"],
                "DRY_RUN",
                "live calls are off",
                **common,
                request_preview=_preview(body),
                **assess_context(model, None, limits, sent=False),
            ),
            known,
        )
    if not api_key:
        return _finish(
            _result(
                provider,
                model,
                case["id"],
                "PENDING_CREDENTIALS",
                f"{adapter.env_var} is not set",
                **common,
                **assess_context(model, None, limits, sent=False),
            ),
            known,
        )
    url = adapter.request_url(options)
    try:
        if not url:
            raise ValueError("request URL is not available")
        ensure_transport_url(url)
    except Exception as exc:  # noqa: BLE001
        return _finish(
            _result(
                provider,
                model,
                case["id"],
                "BLOCKED",
                redact(str(exc), known),
                **common,
                stop_subsequent=True,
                **assess_context(model, None, limits, sent=False),
            ),
            known,
        )
    if not adapter.output_is_bounded(body):
        return _finish(
            _result(
                provider,
                model,
                case["id"],
                "BLOCKED",
                "the request has no supported output-token limit matching the reserved budget",
                **common,
                stop_subsequent=True,
                **assess_context(model, None, limits, sent=False),
            ),
            known,
        )
    rates = priced_rates(pricing, provider, model)
    input_tokens = estimate_request_tokens(body)
    upper = estimate_cost_usd(rates, input_tokens, MAX_OUTPUT_TOKENS) if rates else None
    if rates is None or upper is None:
        return _finish(
            _result(
                provider,
                model,
                case["id"],
                "BLOCKED_COST",
                "price entry must be a finite positive dated rate, so the local cap cannot be enforced",
                **common,
                stop_subsequent=True,
                **assess_context(model, None, limits, sent=False),
            ),
            known,
        )
    if _exceeds(spent_usd + upper, cap_usd):
        return _finish(
            _result(
                provider,
                model,
                case["id"],
                "SKIPPED",
                "spending cap would be exceeded",
                **common,
                estimated_cost_usd=upper,
                **assess_context(model, None, limits, sent=False),
            ),
            known,
        )
    # Headers are built only after the URL and the output bound are accepted.
    headers = _headers(provider, api_key)
    reserved = upper
    spent_held = spent_usd + reserved
    started = time.perf_counter()
    try:
        if transport is None:
            payload = post_json(url, headers, body, timeout)
        else:
            payload = transport(url, headers, body)
    except Exception as exc:  # noqa: BLE001
        return _finish(
            _accounted(
                provider,
                model,
                case,
                "FAILED",
                redact(f"{type(exc).__name__}: {exc}", known),
                calls=[],
                scores=None,
                thinking=thinking,
                commit_sha=commit_sha,
                latency=time.perf_counter() - started,
                reserved=reserved,
                charged=reserved,
                running=spent_held,
                stop=False,
                usage_status="not_reported",
                input_tokens=None,
                output_tokens=None,
                limits=limits,
                sent=True,
                processed=False,
            ),
            known,
        )
    latency = time.perf_counter() - started
    parsed = adapter.parse_response(payload if isinstance(payload, dict) else {})
    calls = parsed["calls"] if isinstance(parsed.get("calls"), list) else []
    if parsed.get("parse_error"):
        return _finish(
            _accounted(
                provider,
                model,
                case,
                "FAILED",
                redact(str(parsed["parse_error"]), known),
                calls=calls,
                scores=None,
                thinking=thinking,
                commit_sha=commit_sha,
                latency=latency,
                reserved=reserved,
                charged=reserved,
                running=spent_held,
                stop=False,
                usage_status="not_reported",
                input_tokens=None,
                output_tokens=None,
                limits=limits,
                sent=True,
                processed=False,
            ),
            known,
        )
    usage = _usage_decision(parsed)
    if usage["state"] == "invalid":
        return _finish(
            _accounted(
                provider,
                model,
                case,
                "BUDGET_UNSAFE",
                "provider token usage was missing a finite non-negative count, so the reservation is kept",
                calls=calls,
                scores=score_case(case, calls),
                thinking=thinking,
                commit_sha=commit_sha,
                latency=latency,
                reserved=reserved,
                charged=reserved,
                running=spent_held,
                stop=True,
                usage_status="rejected",
                input_tokens=None,
                output_tokens=None,
                limits=limits,
                sent=True,
                processed=False,
            ),
            known,
        )
    if usage["state"] == "missing":
        reported_input = usage["input_tokens"] if usage["input_state"] == "ok" else None
        return _finish(
            _accounted(
                provider,
                model,
                case,
                "SUCCESS",
                None,
                calls=calls,
                scores=score_case(case, calls),
                thinking=thinking,
                commit_sha=commit_sha,
                latency=latency,
                reserved=reserved,
                charged=reserved,
                running=spent_held,
                stop=False,
                usage_status="missing",
                input_tokens=reported_input,
                output_tokens=None,
                limits=limits,
                sent=True,
                processed=True,
            ),
            known,
        )
    if usage["input_tokens"] == 0 and usage["output_tokens"] == 0 and prompt.strip():
        return _finish(
            _accounted(
                provider,
                model,
                case,
                "BUDGET_UNSAFE",
                (
                    "provider reported zero input tokens and zero output tokens "
                    "for a nonempty request, so the reservation is kept"
                ),
                calls=calls,
                scores=score_case(case, calls),
                thinking=thinking,
                commit_sha=commit_sha,
                latency=latency,
                reserved=reserved,
                charged=reserved,
                running=spent_held,
                stop=True,
                usage_status="untrusted_zero",
                input_tokens=None,
                output_tokens=None,
                limits=limits,
                sent=True,
                processed=False,
            ),
            known,
        )
    observed = estimate_cost_usd(rates, usage["billed_input"], usage["billed_output"])
    if observed is None:
        return _finish(
            _accounted(
                provider,
                model,
                case,
                "BUDGET_UNSAFE",
                "observed usage could not be priced without lowering the reserved cost unsafely",
                calls=calls,
                scores=score_case(case, calls),
                thinking=thinking,
                commit_sha=commit_sha,
                latency=latency,
                reserved=reserved,
                charged=reserved,
                running=spent_held,
                stop=True,
                usage_status="rejected",
                input_tokens=None,
                output_tokens=None,
                limits=limits,
                sent=True,
                processed=False,
            ),
            known,
        )
    reconciled = spent_usd + observed
    if reconciled < 0:
        return _finish(
            _accounted(
                provider,
                model,
                case,
                "BUDGET_UNSAFE",
                "reconciling usage would make accumulated cost negative, so the reservation is kept",
                calls=calls,
                scores=score_case(case, calls),
                thinking=thinking,
                commit_sha=commit_sha,
                latency=latency,
                reserved=reserved,
                charged=reserved,
                running=spent_held,
                stop=True,
                usage_status="rejected",
                input_tokens=None,
                output_tokens=None,
                limits=limits,
                sent=True,
                processed=False,
            ),
            known,
        )
    return _finish(
        _accounted(
            provider,
            model,
            case,
            "SUCCESS",
            None,
            calls=calls,
            scores=score_case(case, calls),
            thinking=thinking,
            commit_sha=commit_sha,
            latency=latency,
            reserved=reserved,
            charged=observed,
            running=reconciled,
            stop=_exceeds(reconciled, cap_usd),
            usage_status="reported",
            input_tokens=usage["input_tokens"],
            output_tokens=usage["output_tokens"],
            limits=limits,
            sent=True,
            processed=True,
        ),
        known,
    )


def _usage_decision(parsed: dict[str, Any]) -> dict[str, Any]:
    input_state, input_tokens = _classify_token(parsed.get("input_tokens"))
    output_state, output_tokens = _classify_token(parsed.get("output_tokens"))
    thought_raw = parsed.get("thought_tokens")
    thought_state, thought_tokens = _classify_token(thought_raw)
    if "invalid" in {input_state, output_state} or (
        thought_raw is not None and thought_state == "invalid"
    ):
        return {"state": "invalid", "input_state": input_state}
    if input_state != "ok" or output_state != "ok":
        return {
            "state": "missing",
            "input_state": input_state,
            "input_tokens": input_tokens,
        }
    billed_output = output_tokens or 0
    if thought_state == "ok" and thought_tokens is not None:
        billed_output += thought_tokens
    return {
        "state": "ok",
        "input_state": "ok",
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "billed_input": input_tokens,
        "billed_output": billed_output,
    }


def _accounted(
    provider: str,
    model: str,
    case: dict[str, Any],
    status: str,
    reason: str | None,
    calls: list[dict[str, Any]],
    scores: dict[str, bool] | None,
    thinking: dict[str, Any],
    commit_sha: str,
    latency: float,
    reserved: float,
    charged: float,
    running: float,
    stop: bool,
    usage_status: str,
    input_tokens: int | None,
    output_tokens: int | None,
    limits: dict[str, dict[str, Any]],
    sent: bool,
    processed: bool,
) -> dict[str, Any]:
    context = assess_context(model, input_tokens, limits, sent=sent)
    extra: dict[str, Any] = {
        "thinking": thinking,
        "commit_sha": commit_sha,
        "latency_seconds": latency,
        "budget_reserved_usd": reserved,
        "budget_charged_usd": charged,
        "running_spent_usd": running,
        "stop_subsequent": stop,
        "usage_status": usage_status,
        "estimated_cost_usd": charged,
        "request_processed": processed,
        **_transcript_fields(True),
        **context,
    }
    if input_tokens is not None:
        extra["input_tokens"] = input_tokens
    if output_tokens is not None:
        extra["output_tokens"] = output_tokens
    if scores is not None:
        extra.update(scores)
    return _result(
        provider,
        model,
        case["id"],
        status,
        reason,
        calls=calls,
        spent_usd=running,
        **extra,
    )


def _finish(record: dict[str, Any], secrets: list[str]) -> dict[str, Any]:
    # Score fields are already set. Sanitize before the caller logs or stores.
    cleaned = sanitize(record, secrets)
    if not isinstance(cleaned, dict):
        return record
    return cleaned


def _secrets(api_key: str, options: dict[str, Any]) -> list[str]:
    environment = {name: os.environ.get(name, "") for name in SECRET_ENV_NAMES}
    bearer = f"Bearer {api_key}" if api_key else ""
    return collect_secrets(api_key, bearer, options, environment)


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
    hidden = {"messages", "input"}
    preview = {key: body[key] for key in body if key not in hidden}
    preview["prompt_included"] = "messages" in body or "input" in body
    return preview


def stopped_record(
    provider: str,
    model: str,
    case: dict[str, Any],
    commit_sha: str,
    spent_usd: float,
) -> dict[str, Any]:
    return _result(
        provider,
        model,
        case["id"],
        "BLOCKED_BUDGET",
        "stopped because budget safety could not be established",
        spent_usd=spent_usd,
        commit_sha=commit_sha,
        stop_subsequent=True,
        **_transcript_fields(False),
        **assess_context(model, None, {}, sent=False),
    )


def _primary_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [record for record in records if record.get("suite", "primary") == "primary"]


def _guardrail_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [record for record in records if record.get("suite") == "guardrail"]


def summarize(records: list[dict[str, Any]]) -> dict[str, Any]:
    primary = _primary_records(records)
    guardrails = _guardrail_records(records)
    primary_success = [record for record in primary if record["status"] == "SUCCESS"]
    latencies = sorted(
        float(record["latency_seconds"])
        for record in primary_success
        if isinstance(record.get("latency_seconds"), (int, float))
        and math.isfinite(float(record["latency_seconds"]))
    )
    median = None
    if latencies:
        middle = len(latencies) // 2
        median = (
            latencies[middle]
            if len(latencies) % 2
            else (latencies[middle - 1] + latencies[middle]) / 2
        )
    tool_calls = sum(
        1 for record in primary_success if record.get("schema_valid_tool_call") is True
    )
    semantic_hits = sum(
        1 for record in primary_success if record.get("semantic_correct") is True
    )
    abstentions = sum(
        1
        for record in guardrails
        if record["status"] == "SUCCESS" and record.get("correct_abstention") is True
    )
    guardrail_semantic = sum(
        1
        for record in guardrails
        if record["status"] == "SUCCESS" and record.get("semantic_correct") is True
    )
    all_sent = len(primary) == CP1_DENOMINATOR and all(
        record["status"] in SENT_STATUSES for record in primary
    )
    observed = tool_calls >= CP1_THRESHOLD if all_sent else None
    measured = bool(primary_success)
    return {
        "scripted_requests": CP1_DENOMINATOR,
        "live_requests": len(primary_success),
        "schema_valid_tool_calls": tool_calls if all_sent or measured else None,
        "correct_abstentions": abstentions,
        "semantic_correct": semantic_hits if all_sent or measured else None,
        "median_latency_seconds": median,
        "cp1_schema": {
            "schema_valid_tool_calls": tool_calls if all_sent else None,
            "denominator": CP1_DENOMINATOR,
            "threshold": CP1_THRESHOLD,
            "counts_abstentions": False,
            "observed_pass": observed,
        },
        "guardrails": {
            "requests": len(guardrails),
            "correct_abstentions": abstentions if guardrails else None,
            "semantic_correct": guardrail_semantic if guardrails else None,
        },
        "observed_cp1_schema": observed,
        "formal_cp1": "NOT_VERIFIED",
        "measurements": "PENDING" if not measured else "UNREVIEWED",
    }


def case_reservation_usd(
    provider: str,
    model: str,
    case: dict[str, Any],
    transcript: str,
    pricing: dict[str, Any],
    options: dict[str, Any],
) -> float | None:
    """Upper bound reserved before one live request. None when the price or bound is missing."""

    if provider not in registry() or not model.strip():
        return None
    adapter = registry()[provider]
    body = adapter.build_request(model, prompt_for(case, transcript), options)
    if (
        body.get("unsupported")
        or body.get("blocked")
        or not adapter.output_is_bounded(body)
    ):
        return None
    rates = priced_rates(pricing, provider, model)
    if rates is None:
        return None
    return estimate_cost_usd(rates, estimate_request_tokens(body), MAX_OUTPUT_TOKENS)


def maximum_local_reservation_usd(
    provider: str,
    model: str,
    cases: list[dict[str, Any]],
    transcript: str,
    pricing: dict[str, Any],
    options: dict[str, Any],
) -> float | None:
    total = 0.0
    for case in cases:
        amount = case_reservation_usd(
            provider, model, case, transcript, pricing, options
        )
        if amount is None:
            return None
        total += amount
    return total


def log_line(message: str, secrets: list[str]) -> None:
    print(redact(message, secrets), flush=True)


def execute(
    *,
    provider: str,
    model: str,
    live: bool,
    commit_sha: str,
    output: Path,
    spend_cap_usd: float,
    cases: list[dict[str, Any]],
    pricing: dict[str, Any],
    transcript: str,
    api_key: str,
    options: dict[str, Any],
    context_limits: dict[str, dict[str, Any]] | None = None,
    transport: Any = None,
    timeout: float = 60,
) -> dict[str, Any]:
    secrets = _secrets(api_key, options)
    if live and api_key:
        log_line(
            "Live mode was requested. A request is sent only after a local reservation is accepted.",
            secrets,
        )
    limits = context_limits or {}
    spent = 0.0
    stop = not cap_is_valid(spend_cap_usd)
    records: list[dict[str, Any]] = []
    for case in cases:
        if stop:
            if not records and not cap_is_valid(spend_cap_usd):
                record = run_case(
                    provider,
                    model,
                    case,
                    transcript,
                    live,
                    api_key,
                    options,
                    pricing,
                    spent,
                    spend_cap_usd,
                    commit_sha,
                    transport=transport,
                    timeout=timeout,
                    context_limits=limits,
                    secrets=secrets,
                )
            else:
                record = stopped_record(provider, model, case, commit_sha, spent)
                record = _finish(record, secrets)
        else:
            record = run_case(
                provider,
                model,
                case,
                transcript,
                live,
                api_key,
                options,
                pricing,
                spent,
                spend_cap_usd,
                commit_sha,
                transport=transport,
                timeout=timeout,
                context_limits=limits,
                secrets=secrets,
            )
        spent_value = record.get("running_spent_usd")
        if (
            isinstance(spent_value, (int, float))
            and not isinstance(spent_value, bool)
            and math.isfinite(float(spent_value))
            and float(spent_value) >= 0
        ):
            spent = float(spent_value)
        if record.get("stop_subsequent") is True:
            stop = True
        record["suite"] = str(case.get("suite", "primary"))
        records.append(record)
        log_line(
            json.dumps(
                {
                    "request_id": record.get("request_id"),
                    "status": record.get("status"),
                    "reason": record.get("reason"),
                    "calls": record.get("calls"),
                },
                default=str,
            ),
            secrets,
        )
    adapter = registry()[provider]
    summary = summarize(records)
    summary["formal_cp1"] = cp1_formal_status(
        live=live,
        real_transport=transport is None,
        all_primary_sent=len(_primary_records(records)) == CP1_DENOMINATOR
        and all(
            record["status"] in SENT_STATUSES for record in _primary_records(records)
        ),
        observed_pass=summary["observed_cp1_schema"],
    )
    report = {
        "commit_sha": commit_sha,
        "provider": provider,
        "model": model,
        "live": live,
        "spend_cap_usd": spend_cap_usd if cap_is_valid(spend_cap_usd) else None,
        "spend_cap_note": (
            "Local reservation before send. Not a provider-side invoice ceiling."
        ),
        "maximum_local_reservation_usd": maximum_local_reservation_usd(
            provider, model, cases, transcript, pricing, options
        ),
        "summary": summary,
        "documentation": adapter.documentation(),
        "records": records,
    }
    output.mkdir(parents=True, exist_ok=True)
    destination = output / f"{provider}.json"
    destination.write_text(dumps_redacted(report, secrets), encoding="utf-8")
    log_line(str(destination), secrets)
    return report


def _parse_cap(explicit: float | None) -> float:
    if explicit is not None:
        return float(explicit)
    raw = os.environ.get("LLM_BENCHMARK_SPEND_CAP_USD", str(DEFAULT_CAP_USD))
    return float(raw)


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
    cases = load_benchmark(root)
    pricing = load_pricing(root / "pricing.json")
    limits = load_context_limits(root / "context_windows.json")
    transcript = load_transcript()
    adapter = registry()[args.provider]
    api_key = os.environ.get(adapter.env_var, "")
    options = {"dashscope_base_url": os.environ.get("DASHSCOPE_BASE_URL", "")}
    execute(
        provider=args.provider,
        model=args.model,
        live=args.live,
        commit_sha=args.commit_sha,
        output=args.output,
        spend_cap_usd=_parse_cap(args.spend_cap_usd),
        cases=cases,
        pricing=pricing,
        transcript=transcript,
        api_key=api_key,
        options=options,
        context_limits=limits,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

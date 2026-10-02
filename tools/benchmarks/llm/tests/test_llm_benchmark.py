"""Offline tests for the US-107 hosted tool-calling spike."""

from __future__ import annotations

import copy
import io
import json
import sys
import threading
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import adapters
import runner
import scoring
import transcript
from adapters import registry
from provider_docs import PROVIDERS

OPENAI_FIXTURE = {
    "choices": [
        {
            "message": {
                "tool_calls": [
                    {
                        "id": "call-1",
                        "type": "function",
                        "function": {
                            "name": "trim",
                            "arguments": '{"start_seconds": 10, "end_seconds": 25}',
                        },
                    }
                ]
            }
        }
    ],
    "usage": {"prompt_tokens": 20, "completion_tokens": 8},
}


def cases() -> list[dict]:
    return json.loads((ROOT / "requests.json").read_text(encoding="utf-8"))["requests"]


def guardrail_cases() -> list[dict]:
    return json.loads((ROOT / "guardrails.json").read_text(encoding="utf-8"))[
        "requests"
    ]


class DatasetTests(unittest.TestCase):
    def test_ten_primary_requests_expect_tool_calls(self) -> None:
        rows = runner.load_requests(ROOT / "requests.json")
        self.assertEqual(len(rows), 10)
        self.assertTrue(all(row["expected"]["mode"] == "calls" for row in rows))
        tags = {tag for row in rows for tag in row["tags"]}
        for required in (
            "valid_trim",
            "caption",
            "reframe",
            "multi_step",
            "multi_tool",
            "position",
            "timing",
        ):
            self.assertIn(required, tags)
        multi = [row for row in rows if len(row["expected"]["calls"]) > 1]
        self.assertGreaterEqual(len(multi), 1)

    def test_abstention_guardrails_are_outside_the_primary_ten(self) -> None:
        rows = runner.load_guardrails(ROOT / "guardrails.json")
        self.assertEqual(
            {row["id"] for row in rows}, {"ambiguous-request", "out-of-bounds-trim"}
        )
        self.assertTrue(all(row["expected"]["mode"] == "no_calls" for row in rows))
        benchmark = runner.load_benchmark(ROOT)
        self.assertEqual(len(benchmark), 12)
        self.assertEqual(sum(row["suite"] == "primary" for row in benchmark), 10)
        self.assertEqual(sum(row["suite"] == "guardrail" for row in benchmark), 2)

    def test_transcript_is_synthetic_and_ten_minutes(self) -> None:
        text = transcript.build_transcript()
        self.assertEqual(len(text.split()), 1500)
        self.assertNotIn("@", text)
        self.assertEqual(transcript.DURATION_SECONDS, 600)


class ScoringTests(unittest.TestCase):
    def test_schema_valid_wrong_action_is_not_semantic_success(self) -> None:
        case = next(
            row for row in guardrail_cases() if row["id"] == "out-of-bounds-trim"
        )
        calls = [
            {"name": "trim", "arguments": {"start_seconds": 700, "end_seconds": 800}}
        ]
        scored = scoring.score_case(case, calls)
        self.assertTrue(scored["schema_valid"])
        self.assertTrue(scored["schema_valid_tool_call"])
        self.assertFalse(scored["correct_abstention"])
        self.assertFalse(scored["semantic_correct"])

    def test_malformed_arguments_fail_schema(self) -> None:
        calls = [{"name": "trim", "arguments": "{not json"}]
        self.assertFalse(scoring.schema_valid(calls, "calls"))

    def test_empty_calls_are_not_schema_valid_tool_calls(self) -> None:
        self.assertFalse(scoring.schema_valid([], "calls"))
        self.assertFalse(scoring.schema_valid([], "no_calls"))
        expecting_calls = next(row for row in cases() if row["id"] == "trim-keep-range")
        expecting_none = next(
            row for row in guardrail_cases() if row["id"] == "ambiguous-request"
        )
        missed = scoring.score_case(expecting_calls, [])
        abstained = scoring.score_case(expecting_none, [])
        self.assertFalse(missed["schema_valid_tool_call"])
        self.assertFalse(missed["correct_abstention"])
        self.assertFalse(missed["valid_outcome"])
        self.assertFalse(abstained["schema_valid_tool_call"])
        self.assertTrue(abstained["correct_abstention"])
        self.assertTrue(abstained["valid_outcome"])
        self.assertTrue(abstained["semantic_correct"])

    def test_expected_trim_matches(self) -> None:
        case = next(row for row in cases() if row["id"] == "trim-keep-range")
        calls = [
            {"name": "trim", "arguments": {"start_seconds": 10, "end_seconds": 25}}
        ]
        scored = scoring.score_case(case, calls)
        self.assertTrue(scored["schema_valid"])
        self.assertTrue(scored["semantic_correct"])


class AdapterTests(unittest.TestCase):
    def test_registry_has_five_hosted_providers(self) -> None:
        self.assertEqual(
            set(registry()),
            {"openai", "anthropic", "gemini", "qwen", "deepseek"},
        )

    def test_openai_chat_shape_and_parse(self) -> None:
        adapter = registry()["openai"]
        body = adapter.build_request("gpt-5.6-terra", "Keep 10 to 25 seconds.")
        self.assertEqual(body["tools"][0]["function"]["strict"], True)
        self.assertEqual(body["max_completion_tokens"], adapters.MAX_OUTPUT_TOKENS)
        parsed = adapter.parse_response(OPENAI_FIXTURE)
        self.assertEqual(parsed["calls"][0]["name"], "trim")
        self.assertEqual(parsed["input_tokens"], 20)

    def test_openai_responses_only_models_are_unsupported(self) -> None:
        body = registry()["openai"].build_request("gpt-6-astra", "hello")
        self.assertTrue(body["unsupported"])

    def test_anthropic_uses_input_schema(self) -> None:
        adapter = registry()["anthropic"]
        body = adapter.build_request("claude-example", "hello")
        self.assertIn("input_schema", body["tools"][0])
        self.assertNotIn("strict", body["tools"][0])
        self.assertEqual(body["max_tokens"], adapters.MAX_OUTPUT_TOKENS)
        self.assertNotEqual(body["max_tokens"], 1024)
        parsed = adapter.parse_response(
            {
                "content": [
                    {
                        "type": "tool_use",
                        "name": "reframe",
                        "input": {"aspect_ratio": "9:16"},
                    }
                ],
                "usage": {"input_tokens": 3, "output_tokens": 4},
            }
        )
        self.assertEqual(parsed["calls"][0]["arguments"]["aspect_ratio"], "9:16")

    def test_gemini_interactions_shape(self) -> None:
        adapter = registry()["gemini"]
        body = adapter.build_request("gemini-3.8-flash", "hello")
        self.assertEqual(body["tools"][0]["type"], "function")
        self.assertEqual(
            body["generation_config"]["max_output_tokens"], adapters.MAX_OUTPUT_TOKENS
        )
        self.assertEqual(adapter.request_url(), adapters.GEMINI_URL)
        parsed = adapter.parse_response(
            {
                "steps": [
                    {
                        "type": "function_call",
                        "name": "trim",
                        "arguments": {"start_seconds": 0, "end_seconds": 15},
                    }
                ]
            }
        )
        self.assertEqual(parsed["calls"][0]["name"], "trim")

    def test_qwen_requires_base_url_and_disables_thinking(self) -> None:
        adapter = registry()["qwen"]
        missing = adapter.build_request("qwen3.8-max", "hello", {})
        self.assertTrue(missing["unsupported"])
        rejected = adapter.build_request(
            "qwen3.8-max",
            "hello",
            {"dashscope_base_url": "https://example.invalid/compatible-mode/v1"},
        )
        self.assertTrue(rejected["blocked"])
        body = adapter.build_request(
            "qwen3.8-max",
            "hello",
            {
                "dashscope_base_url": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
            },
        )
        self.assertFalse(body["enable_thinking"])
        self.assertEqual(body["max_tokens"], adapters.MAX_OUTPUT_TOKENS)
        self.assertNotIn("reasoning_effort", body)

    def test_deepseek_does_not_send_strict_or_thinking(self) -> None:
        body = registry()["deepseek"].build_request("deepseek-flash", "hello")
        function = body["tools"][0]["function"]
        self.assertNotIn("strict", function)
        self.assertNotIn("enable_thinking", body)
        self.assertEqual(body["max_tokens"], adapters.MAX_OUTPUT_TOKENS)
        self.assertEqual(registry()["deepseek"].request_url(), adapters.DEEPSEEK_URL)

    def test_malformed_openai_payload(self) -> None:
        parsed = registry()["openai"].parse_response({"choices": []})
        self.assertIn("malformed", parsed["parse_error"])
        self.assertEqual(parsed["calls"], [])


class SafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.case = json.loads((ROOT / "requests.json").read_text(encoding="utf-8"))[
            "requests"
        ][0]
        self.pricing = {
            "models": {
                "openai:example-model": {
                    "input_per_million_usd": 1,
                    "output_per_million_usd": 1,
                    "accessed": "2026-10-02",
                }
            }
        }

    def test_dry_run_does_not_call_transport(self) -> None:
        def transport(*_args: object) -> dict:
            raise AssertionError("transport should not be called")

        result = runner.run_case(
            "openai",
            "example-model",
            self.case,
            "short transcript",
            False,
            "sk-secret",
            {},
            self.pricing,
            0,
            1,
            "abc",
            transport=transport,
        )
        self.assertEqual(result["status"], "DRY_RUN")
        self.assertIsNone(result["schema_valid"])

    def test_missing_key_is_pending(self) -> None:
        result = runner.run_case(
            "anthropic",
            "example-model",
            self.case,
            "short",
            True,
            "",
            {},
            self.pricing,
            0,
            1,
            "abc",
            transport=lambda *_args: {},
        )
        self.assertEqual(result["status"], "PENDING_CREDENTIALS")

    def test_missing_price_blocks_live_call(self) -> None:
        called = {"count": 0}

        def transport(*_args: object) -> dict:
            called["count"] += 1
            return {}

        result = runner.run_case(
            "openai",
            "example-model",
            self.case,
            "short",
            True,
            "sk-secret",
            {},
            {"models": {}},
            0,
            1,
            "abc",
            transport=transport,
        )
        self.assertEqual(result["status"], "BLOCKED_COST")
        self.assertEqual(called["count"], 0)

    def test_spend_cap_skips_before_transport(self) -> None:
        result = runner.run_case(
            "openai",
            "example-model",
            self.case,
            "short",
            True,
            "sk-secret",
            {},
            self.pricing,
            0,
            0,
            "abc",
            transport=lambda *_args: OPENAI_FIXTURE,
        )
        self.assertEqual(result["status"], "SKIPPED")
        self.assertIn("cap", result["reason"])

    def test_secret_is_redacted(self) -> None:
        def transport(*_args: object) -> dict:
            raise RuntimeError("failure for key sk-secret")

        result = runner.run_case(
            "openai",
            "example-model",
            self.case,
            "short",
            True,
            "sk-secret",
            {},
            self.pricing,
            0,
            100,
            "abc",
            transport=transport,
        )
        self.assertEqual(result["status"], "FAILED")
        self.assertNotIn("sk-secret", result["reason"])
        self.assertIn("[REDACTED]", result["reason"])

    def test_mocked_success_does_not_close_formal_cp1(self) -> None:
        records = [
            {
                "status": "SUCCESS",
                "schema_valid": True,
                "schema_valid_tool_call": True,
                "correct_abstention": False,
                "valid_outcome": True,
                "semantic_correct": False,
                "latency_seconds": index,
            }
            for index in range(10)
        ]
        summary = runner.summarize(records)
        self.assertTrue(summary["observed_cp1_schema"])
        self.assertEqual(summary["formal_cp1"], "NOT_VERIFIED")
        self.assertNotEqual(summary["formal_cp1"], "PASS")
        self.assertEqual(summary["semantic_correct"], 0)
        self.assertEqual(summary["cp1_schema"]["denominator"], 10)
        self.assertEqual(summary["cp1_schema"]["threshold"], 9)
        self.assertEqual(summary["schema_valid_tool_calls"], 10)
        self.assertEqual(summary["correct_abstentions"], 0)

    def test_documented_examples_are_not_a_default_model(self) -> None:
        for provider in PROVIDERS.values():
            self.assertIn("accessed", provider)
            self.assertEqual(provider["accessed"], "2026-10-02")
        result = runner.run_case(
            "gemini",
            "",
            self.case,
            "short",
            False,
            "",
            {},
            {"models": {}},
            0,
            1,
            "abc",
        )
        self.assertEqual(result["status"], "MISSING_MODEL")
        self.assertNotEqual(result["model"], "gemini-3.8-flash")


DOCUMENTED_DASHSCOPE_BASES = (
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
    "https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1",
    "https://llm-xxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    "https://llm-xxx.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    "https://llm-xxx.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1",
    "https://llm-xxx.eu-central-1.maas.aliyuncs.com/compatible-mode/v1",
    "https://llm-xxx.us-east-1.maas.aliyuncs.com/compatible-mode/v1",
    "https://llm-xxx.cn-hongkong.maas.aliyuncs.com/compatible-mode/v1",
    "https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/",
    "https://trial.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    "https://trial.cn-hongkong.maas.aliyuncs.com/compatible-mode/v1",
)


def _empty_openai(usage: dict | None = None) -> dict:
    payload: dict = {"choices": [{"message": {"tool_calls": []}}]}
    if usage is not None:
        payload["usage"] = usage
    return payload


def _dated_price(
    input_rate: object = 1, output_rate: object = 1, accessed: object = "2026-10-02"
) -> dict:
    row: dict = {
        "input_per_million_usd": input_rate,
        "output_per_million_usd": output_rate,
    }
    if accessed is not None:
        row["accessed"] = accessed
    return {"models": {"openai:example-model": row}}


class Cp1ScoringTests(unittest.TestCase):
    def _record(self, case: dict, calls: list, status: str = "SUCCESS") -> dict:
        scored = scoring.score_case(case, calls)
        return {
            "status": status,
            "suite": case.get("suite", "primary"),
            "schema_valid_tool_call": scored["schema_valid_tool_call"],
            "correct_abstention": scored["correct_abstention"],
            "valid_outcome": scored["valid_outcome"],
            "semantic_correct": scored["semantic_correct"],
            "latency_seconds": 0.01,
        }

    def test_empty_primary_calls_score_zero_of_ten(self) -> None:
        records = [self._record(case, []) for case in cases()]
        for case in guardrail_cases():
            stamped = dict(case)
            stamped["suite"] = "guardrail"
            records.append(self._record(stamped, []))
        summary = runner.summarize(records)
        self.assertEqual(summary["schema_valid_tool_calls"], 0)
        self.assertEqual(summary["correct_abstentions"], 2)
        self.assertEqual(summary["cp1_schema"]["schema_valid_tool_calls"], 0)
        self.assertEqual(summary["cp1_schema"]["denominator"], 10)
        self.assertEqual(summary["cp1_schema"]["threshold"], 9)
        self.assertFalse(summary["cp1_schema"]["counts_abstentions"])
        self.assertIs(summary["observed_cp1_schema"], False)
        self.assertEqual(summary["formal_cp1"], "NOT_VERIFIED")

    def test_guardrail_abstentions_do_not_raise_eight_primary_hits_to_nine(
        self,
    ) -> None:
        records = []
        for index, case in enumerate(cases()):
            calls = case["expected"]["calls"] if index < 8 else []
            records.append(self._record(case, calls))
        for case in guardrail_cases():
            stamped = dict(case)
            stamped["suite"] = "guardrail"
            records.append(self._record(stamped, []))
        summary = runner.summarize(records)
        self.assertEqual(summary["schema_valid_tool_calls"], 8)
        self.assertEqual(summary["correct_abstentions"], 2)
        self.assertIs(summary["observed_cp1_schema"], False)

    def test_failed_primary_requests_are_not_schema_valid_hits(self) -> None:
        records = []
        for index, case in enumerate(cases()):
            status = "FAILED" if index == 0 else "SUCCESS"
            records.append(self._record(case, case["expected"]["calls"], status))
        summary = runner.summarize(records)
        self.assertEqual(summary["schema_valid_tool_calls"], 9)
        self.assertEqual(summary["cp1_schema"]["schema_valid_tool_calls"], 9)
        self.assertIs(summary["observed_cp1_schema"], True)
        self.assertEqual(summary["formal_cp1"], "NOT_VERIFIED")

    def test_mocked_transport_with_no_calls_does_not_pass_cp1(self) -> None:
        def transport(_url: str, _headers: dict, _body: dict) -> dict:
            return _empty_openai({"prompt_tokens": 20, "completion_tokens": 1})

        benchmark = []
        for case in cases():
            stamped = dict(case)
            stamped["suite"] = "primary"
            benchmark.append(stamped)
        for case in guardrail_cases():
            stamped = dict(case)
            stamped["suite"] = "guardrail"
            benchmark.append(stamped)
        report = runner.execute(
            provider="openai",
            model="example-model",
            live=True,
            commit_sha="abc",
            output=Path("/tmp/llm-cp1-empty"),
            spend_cap_usd=1,
            cases=benchmark,
            pricing=_dated_price(),
            transcript="short transcript",
            api_key="sk-mock-openai",
            options={},
            transport=transport,
        )
        summary = report["summary"]
        self.assertEqual(summary["schema_valid_tool_calls"], 0)
        self.assertEqual(summary["correct_abstentions"], 2)
        self.assertEqual(summary["cp1_schema"]["denominator"], 10)
        self.assertFalse(summary["cp1_schema"]["counts_abstentions"])
        self.assertIs(summary["observed_cp1_schema"], False)
        self.assertEqual(summary["formal_cp1"], "NOT_VERIFIED")
        self.assertEqual(
            runner.cp1_formal_status(
                live=True,
                real_transport=False,
                all_primary_sent=True,
                observed_pass=True,
            ),
            "NOT_VERIFIED",
        )
        self.assertEqual(
            runner.cp1_formal_status(
                live=True,
                real_transport=True,
                all_primary_sent=True,
                observed_pass=True,
            ),
            "PASS",
        )
        self.assertEqual(
            runner.cp1_formal_status(
                live=True,
                real_transport=True,
                all_primary_sent=True,
                observed_pass=False,
            ),
            "FAIL",
        )

    def test_skipped_primary_request_does_not_count_as_sent(self) -> None:
        records = [self._record(case, case["expected"]["calls"]) for case in cases()]
        records[0]["status"] = "SKIPPED"
        records[0]["schema_valid_tool_call"] = False
        summary = runner.summarize(records)
        self.assertIsNone(summary["observed_cp1_schema"])
        self.assertEqual(
            runner.cp1_formal_status(
                live=True,
                real_transport=True,
                all_primary_sent=False,
                observed_pass=None,
            ),
            "NOT_VERIFIED",
        )


class BudgetSafetyTests(SafetyTests):
    def test_negative_zero_and_nonfinite_prices_are_rejected(self) -> None:
        for bad in (0, -1, -0.01, float("nan"), float("inf"), float("-inf"), True, "1"):
            called = {"n": 0}

            def transport(*_args: object, counter: dict[str, int] = called) -> dict:
                counter["n"] += 1
                return _empty_openai({"prompt_tokens": 1, "completion_tokens": 1})

            result = runner.run_case(
                "openai",
                "example-model",
                self.case,
                "short",
                True,
                "sk-secret",
                {},
                _dated_price(bad, 1),
                0,
                10,
                "abc",
                transport=transport,
            )
            self.assertEqual(result["status"], "BLOCKED_COST", bad)
            self.assertEqual(called["n"], 0)
            self.assertTrue(result["stop_subsequent"])

    def test_undated_price_is_rejected(self) -> None:
        for accessed in (None, "2026-13-40", "October 2, 2026", ""):
            called = {"n": 0}

            def transport(*_args: object, counter: dict[str, int] = called) -> dict:
                counter["n"] += 1
                return {}

            pricing = _dated_price(
                accessed="2026-10-02" if accessed is None else accessed
            )
            if accessed is None:
                pricing["models"]["openai:example-model"].pop("accessed", None)
            result = runner.run_case(
                "openai",
                "example-model",
                self.case,
                "short",
                True,
                "sk-secret",
                {},
                pricing,
                0,
                10,
                "abc",
                transport=transport,
            )
            self.assertEqual(result["status"], "BLOCKED_COST")
            self.assertEqual(called["n"], 0)

    def test_invalid_spend_caps_are_rejected(self) -> None:
        for cap in (float("nan"), float("inf"), float("-inf"), -1, -0.01, True):
            called = {"n": 0}

            def transport(*_args: object, counter: dict[str, int] = called) -> dict:
                counter["n"] += 1
                return {}

            result = runner.run_case(
                "openai",
                "example-model",
                self.case,
                "short",
                True,
                "sk-secret",
                {},
                self.pricing,
                0,
                cap,  # type: ignore[arg-type]
                "abc",
                transport=transport,
            )
            self.assertEqual(result["status"], "BLOCKED_BUDGET", cap)
            self.assertEqual(called["n"], 0)
            self.assertTrue(result["stop_subsequent"])

    def test_negative_token_usage_cannot_reduce_spend(self) -> None:
        called = {"n": 0}

        def transport(_url: str, _headers: dict, _body: dict) -> dict:
            called["n"] += 1
            if called["n"] > 1:
                raise AssertionError("subsequent request was sent")
            return _empty_openai({"prompt_tokens": -5, "completion_tokens": -1_000_000})

        second = dict(self.case)
        second["id"] = "second"
        report = runner.execute(
            provider="openai",
            model="example-model",
            live=True,
            commit_sha="abc",
            output=Path("/tmp/llm-negative-usage"),
            spend_cap_usd=100,
            cases=[self.case, second],
            pricing=self.pricing,
            transcript="short",
            api_key="sk-secret",
            options={},
            transport=transport,
        )
        first = report["records"][0]
        self.assertEqual(called["n"], 1)
        self.assertEqual(first["status"], "BUDGET_UNSAFE")
        self.assertGreater(first["budget_reserved_usd"], 0)
        self.assertAlmostEqual(first["running_spent_usd"], first["budget_reserved_usd"])
        self.assertGreaterEqual(first["running_spent_usd"], 0)
        self.assertEqual(report["records"][1]["status"], "BLOCKED_BUDGET")

    def test_missing_output_usage_keeps_the_reservation(self) -> None:
        def transport(_url: str, _headers: dict, _body: dict) -> dict:
            return _empty_openai({"prompt_tokens": 12})

        result = runner.run_case(
            "openai",
            "example-model",
            self.case,
            "short",
            True,
            "sk-secret",
            {},
            self.pricing,
            0,
            100,
            "abc",
            transport=transport,
        )
        rates = (1.0, 1.0)
        treated_as_free_output = runner.estimate_cost_usd(rates, 12, 0)
        self.assertEqual(result["status"], "SUCCESS")
        self.assertIsNone(result["output_tokens"])
        self.assertEqual(result["usage_status"], "missing")
        self.assertAlmostEqual(
            result["budget_charged_usd"], result["budget_reserved_usd"]
        )
        self.assertGreater(result["budget_charged_usd"], treated_as_free_output or 0)

    def test_zero_input_and_output_keeps_reservation_and_stops(self) -> None:
        called = {"n": 0}

        def transport(_url: str, _headers: dict, _body: dict) -> dict:
            called["n"] += 1
            if called["n"] > 1:
                raise AssertionError("subsequent request was sent")
            return _empty_openai({"prompt_tokens": 0, "completion_tokens": 0})

        second = dict(self.case)
        second["id"] = "second"
        report = runner.execute(
            provider="openai",
            model="example-model",
            live=True,
            commit_sha="abc",
            output=Path("/tmp/llm-zero-usage"),
            spend_cap_usd=100,
            cases=[self.case, second],
            pricing=self.pricing,
            transcript="short",
            api_key="sk-secret",
            options={},
            transport=transport,
        )
        first = report["records"][0]
        self.assertEqual(called["n"], 1)
        self.assertEqual(first["status"], "BUDGET_UNSAFE")
        self.assertEqual(first["usage_status"], "untrusted_zero")
        self.assertIn("zero input tokens and zero output tokens", first["reason"])
        self.assertGreater(first["budget_reserved_usd"], 0)
        self.assertAlmostEqual(
            first["budget_charged_usd"], first["budget_reserved_usd"]
        )
        self.assertGreaterEqual(
            first["running_spent_usd"], first["budget_reserved_usd"]
        )
        self.assertEqual(report["records"][1]["status"], "BLOCKED_BUDGET")

    def test_zero_output_with_reported_input_still_reconciles(self) -> None:
        def transport(_url: str, _headers: dict, _body: dict) -> dict:
            return _empty_openai({"prompt_tokens": 12, "completion_tokens": 0})

        result = runner.run_case(
            "openai",
            "example-model",
            self.case,
            "short",
            True,
            "sk-secret",
            {},
            self.pricing,
            0,
            100,
            "abc",
            transport=transport,
        )
        self.assertEqual(result["status"], "SUCCESS")
        self.assertEqual(result["usage_status"], "reported")
        self.assertFalse(result["stop_subsequent"])
        self.assertLess(result["budget_charged_usd"], result["budget_reserved_usd"])

    def test_failed_request_keeps_its_reservation(self) -> None:
        body = registry()["openai"].build_request(
            "example-model", runner.prompt_for(self.case, "short"), {}
        )
        upper = runner.estimate_cost_usd(
            (1.0, 1.0), runner.estimate_request_tokens(body), 800
        )
        self.assertIsNotNone(upper)
        called = {"n": 0}

        def transport(*_args: object) -> dict:
            called["n"] += 1
            raise TimeoutError("timed out")

        second = dict(self.case)
        second["id"] = "second"
        report = runner.execute(
            provider="openai",
            model="example-model",
            live=True,
            commit_sha="abc",
            output=Path("/tmp/llm-failed-budget"),
            spend_cap_usd=upper or 0,
            cases=[self.case, second],
            pricing=self.pricing,
            transcript="short",
            api_key="sk-secret",
            options={},
            transport=transport,
        )
        self.assertEqual(called["n"], 1)
        first = report["records"][0]
        self.assertEqual(first["status"], "FAILED")
        self.assertAlmostEqual(first["budget_charged_usd"], upper)
        self.assertAlmostEqual(first["running_spent_usd"], upper)
        self.assertEqual(report["records"][1]["status"], "SKIPPED")

    def test_tool_definitions_are_included_in_the_reservation(self) -> None:
        prompt = runner.prompt_for(self.case, "short")
        body = registry()["openai"].build_request("example-model", prompt, {})
        full_tokens = runner.estimate_request_tokens(body)
        prompt_tokens = runner.estimate_tokens(prompt)
        self.assertGreater(full_tokens, prompt_tokens)
        rates = (1_000_000.0, 1_000_000.0)
        prompt_cost = runner.estimate_cost_usd(
            rates, prompt_tokens, adapters.MAX_OUTPUT_TOKENS
        )
        full_cost = runner.estimate_cost_usd(
            rates, full_tokens, adapters.MAX_OUTPUT_TOKENS
        )
        self.assertIsNotNone(prompt_cost)
        self.assertIsNotNone(full_cost)
        self.assertGreater(full_cost or 0, prompt_cost or 0)
        called = {"n": 0}

        def transport(*_args: object) -> dict:
            called["n"] += 1
            return _empty_openai({"prompt_tokens": 1, "completion_tokens": 1})

        result = runner.run_case(
            "openai",
            "example-model",
            self.case,
            "short",
            True,
            "sk-secret",
            {},
            _dated_price(1_000_000, 1_000_000),
            0,
            prompt_cost or 0,
            "abc",
            transport=transport,
        )
        self.assertEqual(result["status"], "SKIPPED")
        self.assertEqual(called["n"], 0)

    def test_every_provider_request_caps_output_at_the_budget(self) -> None:
        captured: dict[str, dict] = {}

        def transport(url: str, _headers: dict, body: dict) -> dict:
            captured[url] = body
            if "api.anthropic.com" in url:
                return {
                    "content": [],
                    "usage": {"input_tokens": 3, "output_tokens": 1},
                }
            if "generativelanguage.googleapis.com" in url:
                return {
                    "steps": [],
                    "usage": {"total_input_tokens": 3, "total_output_tokens": 1},
                }
            return _empty_openai({"prompt_tokens": 3, "completion_tokens": 1})

        qwen_options = {
            "dashscope_base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1"
        }
        for provider, options in (
            ("openai", {}),
            ("anthropic", {}),
            ("gemini", {}),
            ("qwen", qwen_options),
            ("deepseek", {}),
        ):
            result = runner.run_case(
                provider,
                "example-model",
                self.case,
                "short",
                True,
                "sk-provider-test",
                options,
                {
                    "models": {
                        f"{provider}:example-model": {
                            "input_per_million_usd": 1,
                            "output_per_million_usd": 1,
                            "accessed": "2026-10-02",
                        }
                    }
                },
                0,
                100,
                "abc",
                transport=transport,
            )
            self.assertEqual(result["status"], "SUCCESS", provider)
        openai_body = next(
            body for url, body in captured.items() if "api.openai.com" in url
        )
        anthropic_body = next(
            body for url, body in captured.items() if "api.anthropic.com" in url
        )
        gemini_body = next(
            body
            for url, body in captured.items()
            if "generativelanguage.googleapis.com" in url
        )
        qwen_body = next(
            body for url, body in captured.items() if "dashscope.aliyuncs.com" in url
        )
        deepseek_body = next(
            body for url, body in captured.items() if "api.deepseek.com" in url
        )
        self.assertEqual(openai_body["max_completion_tokens"], 800)
        self.assertEqual(anthropic_body["max_tokens"], 800)
        self.assertEqual(gemini_body["generation_config"]["max_output_tokens"], 800)
        self.assertEqual(qwen_body["max_tokens"], 800)
        self.assertEqual(deepseek_body["max_tokens"], 800)

    def test_unbounded_request_is_blocked_before_transport(self) -> None:
        called = {"n": 0}

        def transport(*_args: object) -> dict:
            called["n"] += 1
            return {}

        original = adapters.OpenAIAdapter.output_is_bounded
        adapters.OpenAIAdapter.output_is_bounded = lambda self, body: False  # type: ignore[method-assign]
        try:
            result = runner.run_case(
                "openai",
                "example-model",
                self.case,
                "short",
                True,
                "sk-secret",
                {},
                self.pricing,
                0,
                100,
                "abc",
                transport=transport,
            )
        finally:
            adapters.OpenAIAdapter.output_is_bounded = original  # type: ignore[method-assign]
        self.assertEqual(result["status"], "BLOCKED")
        self.assertEqual(called["n"], 0)
        self.assertFalse(
            adapters.AnthropicAdapter().output_is_bounded({"max_tokens": 1024})
        )

    def test_gemini_documented_usage_fields_are_priced(self) -> None:
        parsed = registry()["gemini"].parse_response(
            {
                "steps": [],
                "usage": {
                    "input_tokens": 5,
                    "output_tokens": 0,
                    "total_input_tokens": 11,
                    "total_output_tokens": 4,
                    "total_thought_tokens": 2,
                },
            }
        )
        self.assertEqual(parsed["input_tokens"], 11)
        self.assertEqual(parsed["output_tokens"], 4)
        self.assertEqual(parsed["thought_tokens"], 2)

        def transport(_url: str, _headers: dict, _body: dict) -> dict:
            return {
                "steps": [],
                "usage": {
                    "total_input_tokens": 11,
                    "total_output_tokens": 4,
                    "total_thought_tokens": 2,
                },
            }

        result = runner.run_case(
            "gemini",
            "example-model",
            self.case,
            "short",
            True,
            "sk-gemini",
            {},
            {
                "models": {
                    "gemini:example-model": {
                        "input_per_million_usd": 1,
                        "output_per_million_usd": 1,
                        "accessed": "2026-10-02",
                    }
                }
            },
            0,
            100,
            "abc",
            transport=transport,
        )
        expected = runner.estimate_cost_usd((1.0, 1.0), 11, 6)
        self.assertEqual(result["status"], "SUCCESS")
        self.assertEqual(result["input_tokens"], 11)
        self.assertEqual(result["output_tokens"], 4)
        self.assertAlmostEqual(result["budget_charged_usd"], expected)

    def test_gemini_legacy_usage_names_do_not_zero_the_bill(self) -> None:
        def transport(_url: str, _headers: dict, _body: dict) -> dict:
            return {"steps": [], "usage": {"input_tokens": 9, "output_tokens": 0}}

        result = runner.run_case(
            "gemini",
            "example-model",
            self.case,
            "short",
            True,
            "sk-gemini",
            {},
            {
                "models": {
                    "gemini:example-model": {
                        "input_per_million_usd": 1,
                        "output_per_million_usd": 1,
                        "accessed": "2026-10-02",
                    }
                }
            },
            0,
            100,
            "abc",
            transport=transport,
        )
        self.assertEqual(result["usage_status"], "missing")
        self.assertIsNone(result["output_tokens"])
        self.assertAlmostEqual(
            result["budget_charged_usd"], result["budget_reserved_usd"]
        )


class DashScopeEndpointTests(unittest.TestCase):
    def test_documented_https_endpoints_remain_usable(self) -> None:
        for base in DOCUMENTED_DASHSCOPE_BASES:
            url, error = adapters.dashscope_chat_url(base)
            self.assertIsNone(error, base)
            self.assertTrue(url.startswith("https://"))
            self.assertTrue(url.endswith("/compatible-mode/v1/chat/completions"), url)
        called = {}

        def transport(url: str, headers: dict, body: dict) -> dict:
            called["url"] = url
            called["authorization"] = headers.get("authorization")
            called["thinking"] = body.get("enable_thinking")
            return _empty_openai({"prompt_tokens": 4, "completion_tokens": 1})

        result = runner.run_case(
            "qwen",
            "example-model",
            cases()[0],
            "short",
            True,
            "sk-fake-qwen-0001",
            {"dashscope_base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1"},
            {
                "models": {
                    "qwen:example-model": {
                        "input_per_million_usd": 1,
                        "output_per_million_usd": 1,
                        "accessed": "2026-10-02",
                    }
                }
            },
            0,
            10,
            "abc",
            transport=transport,
        )
        self.assertEqual(result["status"], "SUCCESS")
        self.assertEqual(
            called["url"],
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        )
        self.assertEqual(called["authorization"], "Bearer sk-fake-qwen-0001")
        self.assertIs(called["thinking"], False)

    def test_local_and_link_local_endpoints_are_rejected_without_a_request(
        self,
    ) -> None:
        class Boom:
            def __init__(self, *_args: object, **_kwargs: object) -> None:
                raise AssertionError("socket opened")

        secret = "sk-fake-link-local"
        with (
            patch("adapters.http_client.HTTPConnection", Boom),
            patch("adapters.http_client.HTTPSConnection", Boom),
        ):
            for url in (
                "http://169.254.169.254/latest/meta-data",
                "https://169.254.169.254/",
                "https://example.invalid/v1/chat/completions",
            ):
                with self.assertRaises(adapters.EndpointRejected):
                    adapters.post_json(
                        url, {"authorization": f"Bearer {secret}"}, {}, 1
                    )
        for base in (
            "http://127.0.0.1:9/exfil",
            "http://localhost/compatible-mode/v1",
            "https://169.254.169.254/compatible-mode/v1",
            "https://169.254.169.254/",
            "https://user:pass@dashscope.aliyuncs.com/compatible-mode/v1",
            "https://dashscope.aliyuncs.com:444/compatible-mode/v1",
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            "https://dashscope.aliyuncs.com/api/v1",
            "https://dashscope.aliyuncs.com.evil.example/compatible-mode/v1",
            "https://evil.com/compatible-mode/v1",
            "https://dashscope.aliyuncs.com/compatible-mode/v1?next=http://evil.test",
            "http://dashscope.aliyuncs.com/compatible-mode/v1",
            "https://a.b.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        ):
            called = {"n": 0}

            def transport(*_args: object, counter: dict[str, int] = called) -> dict:
                counter["n"] += 1
                return {}

            result = runner.run_case(
                "qwen",
                "example-model",
                cases()[0],
                "short",
                True,
                secret,
                {"dashscope_base_url": base},
                {
                    "models": {
                        "qwen:example-model": {
                            "input_per_million_usd": 1,
                            "output_per_million_usd": 1,
                            "accessed": "2026-10-02",
                        }
                    }
                },
                0,
                10,
                "abc",
                transport=transport,
            )
            self.assertEqual(result["status"], "BLOCKED", base)
            self.assertEqual(called["n"], 0, base)
            self.assertNotIn(secret, json.dumps(result))

    def test_redirect_cannot_forward_authorization(self) -> None:
        secret = "sk-redirect-fake-0001"

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                self.rfile.read(length)
                self.server.seen.append(  # type: ignore[attr-defined]
                    {
                        "path": self.path,
                        "authorization": self.headers.get("Authorization"),
                    }
                )
                target = getattr(self.server, "redirect_to", None)
                if target:
                    self.send_response(307)
                    self.send_header("Location", target)
                    self.end_headers()
                    return
                body = b"{}"
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, _format: str, *_args: object) -> None:
                return

        steal = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        origin = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        steal.seen = []  # type: ignore[attr-defined]
        origin.seen = []  # type: ignore[attr-defined]
        origin.redirect_to = f"http://127.0.0.1:{steal.server_address[1]}/steal"  # type: ignore[attr-defined]
        for server in (steal, origin):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with self.assertRaises(adapters.RedirectBlocked) as caught:
                adapters.post_json(
                    f"http://127.0.0.1:{origin.server_address[1]}/v1/chat/completions",
                    {
                        "authorization": f"Bearer {secret}",
                        "content-type": "application/json",
                    },
                    {"model": "x"},
                    5,
                )
            self.assertNotIn(secret, str(caught.exception))
            self.assertEqual(steal.seen, [])  # type: ignore[attr-defined]
            self.assertEqual(len(origin.seen), 1)  # type: ignore[attr-defined]
        finally:
            origin.shutdown()
            steal.shutdown()
            origin.server_close()
            steal.server_close()


class SecretExportTests(unittest.TestCase):
    def test_echoed_api_key_is_absent_from_report_logs_and_errors(self) -> None:
        secret = "sk-fake-caption-9f3a2b7c"
        case = copy.deepcopy(
            next(row for row in cases() if row["id"] == "caption-bottom")
        )
        case["expected"]["calls"][0]["arguments"]["text"] = secret
        arguments = json.dumps(case["expected"]["calls"][0]["arguments"])

        def transport(_url: str, headers: dict, _body: dict) -> dict:
            self.assertIn("authorization", {key.lower() for key in headers})
            return {
                "choices": [
                    {
                        "message": {
                            "tool_calls": [
                                {
                                    "function": {
                                        "name": "add_caption",
                                        "arguments": arguments,
                                    }
                                }
                            ]
                        }
                    }
                ],
                "usage": {"prompt_tokens": 20, "completion_tokens": 8},
            }

        stdout = io.StringIO()
        output = Path("/tmp/llm-secret-export")
        with redirect_stdout(stdout):
            report = runner.execute(
                provider="openai",
                model="example-model",
                live=True,
                commit_sha="abc",
                output=output,
                spend_cap_usd=10,
                cases=[case],
                pricing=_dated_price(),
                transcript="short",
                api_key=secret,
                options={},
                transport=transport,
            )
        persisted = (output / "openai.json").read_text(encoding="utf-8")
        record = report["records"][0]
        self.assertTrue(record["semantic_correct"])
        self.assertTrue(record["schema_valid_tool_call"])
        self.assertNotIn(secret, persisted)
        self.assertNotIn(secret, stdout.getvalue())
        self.assertNotIn(secret, json.dumps(record))
        self.assertNotIn(secret, record["reason"] or "")
        self.assertIn("[REDACTED]", persisted)

    def test_exception_text_and_console_omit_the_key(self) -> None:
        secret = "sk-fake-error-key-77aa"

        def transport(*_args: object) -> dict:
            raise RuntimeError(f"upstream failed for {secret}")

        stdout = io.StringIO()
        output = Path("/tmp/llm-secret-error")
        with redirect_stdout(stdout):
            report = runner.execute(
                provider="openai",
                model="example-model",
                live=True,
                commit_sha="abc",
                output=output,
                spend_cap_usd=10,
                cases=cases()[:1],
                pricing=_dated_price(),
                transcript="short",
                api_key=secret,
                options={},
                transport=transport,
            )
        persisted = (output / "openai.json").read_text(encoding="utf-8")
        self.assertEqual(report["records"][0]["status"], "FAILED")
        self.assertNotIn(secret, persisted)
        self.assertNotIn(secret, stdout.getvalue())
        self.assertNotIn(secret, report["records"][0]["reason"])
        self.assertIn("[REDACTED]", report["records"][0]["reason"])


class ContextWindowTests(unittest.TestCase):
    def _limits(self, limit: int) -> dict:
        return {
            "example-model": {
                "limit_tokens": limit,
                "source_url": "https://example.com/model-card",
                "accessed": "2026-10-02",
            }
        }

    def test_reported_usage_can_fit_or_exceed_a_documented_limit(self) -> None:
        def transport_for(tokens: int):
            def transport(_url: str, _headers: dict, _body: dict) -> dict:
                return _empty_openai({"prompt_tokens": tokens, "completion_tokens": 1})

            return transport

        fits = runner.run_case(
            "openai",
            "example-model",
            cases()[0],
            "short",
            True,
            "sk-secret",
            {},
            _dated_price(),
            0,
            10,
            "abc",
            transport=transport_for(100),
            context_limits=self._limits(1000),
        )
        exceeds = runner.run_case(
            "openai",
            "example-model",
            cases()[0],
            "short",
            True,
            "sk-secret",
            {},
            _dated_price(),
            0,
            10,
            "abc",
            transport=transport_for(5000),
            context_limits=self._limits(1000),
        )
        self.assertEqual(fits["context_window"], "FITS")
        self.assertEqual(exceeds["context_window"], "EXCEEDS")
        self.assertTrue(fits["request_processed"])
        self.assertTrue(fits["transcript_included"])
        self.assertEqual(fits["transcript_kind"], "synthetic")
        self.assertNotEqual(fits["context_window"], "UNKNOWN")

    def test_success_without_a_documented_limit_stays_unverified(self) -> None:
        def transport(_url: str, _headers: dict, _body: dict) -> dict:
            return _empty_openai({"prompt_tokens": 40, "completion_tokens": 2})

        result = runner.run_case(
            "openai",
            "example-model",
            cases()[0],
            "short",
            True,
            "sk-secret",
            {},
            _dated_price(),
            0,
            10,
            "abc",
            transport=transport,
            context_limits={},
        )
        self.assertEqual(result["status"], "SUCCESS")
        self.assertTrue(result["request_processed"])
        self.assertTrue(result["transcript_included"])
        self.assertEqual(result["context_window"], "UNVERIFIED")
        self.assertIn("documented", result["context_window_reason"])
        self.assertNotEqual(result["context_window"], "FITS")

    def test_dry_run_does_not_claim_a_context_fit(self) -> None:
        result = runner.run_case(
            "openai",
            "example-model",
            cases()[0],
            "short",
            False,
            "",
            {},
            {"models": {}},
            0,
            1,
            "abc",
        )
        self.assertEqual(result["status"], "DRY_RUN")
        self.assertFalse(result["request_processed"])
        self.assertTrue(result["transcript_included"])
        self.assertEqual(result["context_window"], "UNVERIFIED")
        self.assertNotEqual(result["context_window"], "UNKNOWN")


if __name__ == "__main__":
    unittest.main()

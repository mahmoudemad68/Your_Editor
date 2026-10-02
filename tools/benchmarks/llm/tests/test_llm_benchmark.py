"""Offline tests for the US-107 hosted tool-calling spike."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

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


class DatasetTests(unittest.TestCase):
    def test_ten_requests_cover_the_required_situations(self) -> None:
        rows = cases()
        self.assertEqual(len(rows), 10)
        tags = {tag for row in rows for tag in row["tags"]}
        for required in (
            "valid_trim",
            "caption",
            "reframe",
            "multi_step",
            "multi_tool",
            "ambiguous",
            "out_of_bounds",
            "position",
            "timing",
        ):
            self.assertIn(required, tags)
        multi = [row for row in rows if len(row["expected"]["calls"]) > 1]
        self.assertGreaterEqual(len(multi), 1)

    def test_transcript_is_synthetic_and_ten_minutes(self) -> None:
        text = transcript.build_transcript()
        self.assertEqual(len(text.split()), 1500)
        self.assertNotIn("@", text)
        self.assertEqual(transcript.DURATION_SECONDS, 600)


class ScoringTests(unittest.TestCase):
    def test_schema_valid_wrong_action_is_not_semantic_success(self) -> None:
        case = next(row for row in cases() if row["id"] == "out-of-bounds-trim")
        calls = [
            {"name": "trim", "arguments": {"start_seconds": 700, "end_seconds": 800}}
        ]
        scored = scoring.score_case(case, calls)
        self.assertTrue(scored["schema_valid"])
        self.assertFalse(scored["semantic_correct"])

    def test_malformed_arguments_fail_schema(self) -> None:
        calls = [{"name": "trim", "arguments": "{not json"}]
        self.assertFalse(scoring.schema_valid(calls))

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
        body = adapter.build_request(
            "qwen3.8-max",
            "hello",
            {"dashscope_base_url": "https://example.invalid/compatible-mode/v1"},
        )
        self.assertFalse(body["enable_thinking"])
        self.assertNotIn("reasoning_effort", body)

    def test_deepseek_does_not_send_strict_or_thinking(self) -> None:
        body = registry()["deepseek"].build_request("deepseek-flash", "hello")
        function = body["tools"][0]["function"]
        self.assertNotIn("strict", function)
        self.assertNotIn("enable_thinking", body)
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
                "semantic_correct": False,
                "latency_seconds": index,
            }
            for index in range(10)
        ]
        summary = runner.summarize(records)
        self.assertTrue(summary["observed_cp1_schema"])
        self.assertEqual(summary["formal_cp1"], "NOT_VERIFIED")
        self.assertEqual(summary["semantic_correct"], 0)

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


if __name__ == "__main__":
    unittest.main()

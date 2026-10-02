"""Hosted-provider transports for the US-107 spike.

Each adapter builds a provider request and parses a provider response.
Normalized tool calls are the only shape the scorer sees.
"""

from __future__ import annotations

import json
from typing import Any
from urllib import request as urlrequest

from provider_docs import PROVIDERS

from tools import TOOLS

OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"


def redact(text: str, secrets: list[str]) -> str:
    redacted = text
    for secret in secrets:
        if secret:
            redacted = redacted.replace(secret, "[REDACTED]")
    return redacted


def _openai_tools() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": name,
                "description": spec["description"],
                "parameters": spec["parameters"],
                "strict": True,
            },
        }
        for name, spec in TOOLS.items()
    ]


def _anthropic_tools() -> list[dict[str, Any]]:
    return [
        {
            "name": name,
            "description": spec["description"],
            "input_schema": spec["parameters"],
        }
        for name, spec in TOOLS.items()
    ]


def _gemini_tools() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "name": name,
            "description": spec["description"],
            "parameters": spec["parameters"],
        }
        for name, spec in TOOLS.items()
    ]


def _deepseek_tools() -> list[dict[str, Any]]:
    """Chat Completions tools without strict. Strict is a DeepSeek beta feature."""

    return [
        {
            "type": "function",
            "function": {
                "name": name,
                "description": spec["description"],
                "parameters": spec["parameters"],
            },
        }
        for name, spec in TOOLS.items()
    ]


class ProviderAdapter:
    provider_id = ""
    env_var = ""

    def documentation(self) -> dict[str, object]:
        return PROVIDERS[self.provider_id]

    def build_request(
        self, model: str, prompt: str, options: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        raise NotImplementedError

    def parse_response(self, payload: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    def request_url(self, options: dict[str, Any] | None = None) -> str:
        raise NotImplementedError


class OpenAIAdapter(ProviderAdapter):
    provider_id = "openai"
    env_var = "OPENAI_API_KEY"

    def request_url(self, options: dict[str, Any] | None = None) -> str:
        return OPENAI_CHAT_URL

    def build_request(
        self, model: str, prompt: str, options: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        options = options or {}
        if _responses_only(model):
            return {
                "unsupported": True,
                "reason": (
                    "Documentation accessed 2026-10-02 says GPT-6 Astra and GPT-6.1 Sol "
                    "require the Responses API. This adapter sends Chat Completions only."
                ),
            }
        body: dict[str, Any] = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "tools": _openai_tools(),
            "tool_choice": "auto",
        }
        effort = options.get("openai_reasoning_effort")
        if effort:
            body["reasoning_effort"] = effort
        return body

    def parse_response(self, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            message = payload["choices"][0]["message"]
            raw_calls = message.get("tool_calls") or []
            calls = [
                {
                    "name": item["function"]["name"],
                    "arguments": item["function"].get("arguments", ""),
                }
                for item in raw_calls
            ]
        except (KeyError, IndexError, TypeError) as exc:
            return _malformed(str(exc))
        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
        return {
            "calls": calls,
            "input_tokens": usage.get("prompt_tokens"),
            "output_tokens": usage.get("completion_tokens"),
            "parse_error": None,
        }


class AnthropicAdapter(ProviderAdapter):
    provider_id = "anthropic"
    env_var = "ANTHROPIC_API_KEY"

    def request_url(self, options: dict[str, Any] | None = None) -> str:
        return ANTHROPIC_URL

    def build_request(
        self, model: str, prompt: str, options: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return {
            "model": model,
            "max_tokens": 1024,
            "tools": _anthropic_tools(),
            "messages": [{"role": "user", "content": prompt}],
        }

    def headers(self, api_key: str) -> dict[str, str]:
        return {
            "content-type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": ANTHROPIC_VERSION,
        }

    def parse_response(self, payload: dict[str, Any]) -> dict[str, Any]:
        content = payload.get("content")
        if not isinstance(content, list):
            return _malformed("content is not a list")
        calls = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                calls.append(
                    {"name": block.get("name"), "arguments": block.get("input")}
                )
        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
        return {
            "calls": calls,
            "input_tokens": usage.get("input_tokens"),
            "output_tokens": usage.get("output_tokens"),
            "parse_error": None,
        }


class GeminiAdapter(ProviderAdapter):
    provider_id = "gemini"
    env_var = "GEMINI_API_KEY"

    def request_url(self, options: dict[str, Any] | None = None) -> str:
        return GEMINI_URL

    def build_request(
        self, model: str, prompt: str, options: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return {"model": model, "input": prompt, "tools": _gemini_tools()}

    def headers(self, api_key: str) -> dict[str, str]:
        return {"content-type": "application/json", "x-goog-api-key": api_key}

    def parse_response(self, payload: dict[str, Any]) -> dict[str, Any]:
        steps = payload.get("steps")
        if not isinstance(steps, list):
            return _malformed("steps is not a list")
        calls = []
        for step in steps:
            if isinstance(step, dict) and step.get("type") == "function_call":
                calls.append(
                    {"name": step.get("name"), "arguments": step.get("arguments")}
                )
        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
        return {
            "calls": calls,
            "input_tokens": usage.get("input_tokens"),
            "output_tokens": usage.get("output_tokens"),
            "parse_error": None,
        }


class QwenAdapter(ProviderAdapter):
    provider_id = "qwen"
    env_var = "DASHSCOPE_API_KEY"

    def request_url(self, options: dict[str, Any] | None = None) -> str:
        options = options or {}
        base = str(options.get("dashscope_base_url") or "").rstrip("/")
        if not base:
            return ""
        return f"{base}/chat/completions"

    def build_request(
        self, model: str, prompt: str, options: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        if not self.request_url(options):
            return {
                "unsupported": True,
                "reason": (
                    "DASHSCOPE_BASE_URL is required. The Qwen guide uses a "
                    "workspace-specific compatible-mode host."
                ),
            }
        return {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "tools": _openai_tools(),
            "enable_thinking": False,
        }

    def parse_response(self, payload: dict[str, Any]) -> dict[str, Any]:
        return OpenAIAdapter().parse_response(payload)


class DeepSeekAdapter(ProviderAdapter):
    provider_id = "deepseek"
    env_var = "DEEPSEEK_API_KEY"

    def request_url(self, options: dict[str, Any] | None = None) -> str:
        return DEEPSEEK_URL

    def build_request(
        self, model: str, prompt: str, options: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "tools": _deepseek_tools(),
        }

    def parse_response(self, payload: dict[str, Any]) -> dict[str, Any]:
        return OpenAIAdapter().parse_response(payload)


def _responses_only(model: str) -> bool:
    folded = model.lower()
    return "gpt-6" in folded and ("astra" in folded or "sol" in folded)


def _malformed(reason: str) -> dict[str, Any]:
    return {
        "calls": [],
        "input_tokens": None,
        "output_tokens": None,
        "parse_error": f"malformed provider response: {reason}",
    }


def registry() -> dict[str, ProviderAdapter]:
    adapters: list[ProviderAdapter] = [
        OpenAIAdapter(),
        AnthropicAdapter(),
        GeminiAdapter(),
        QwenAdapter(),
        DeepSeekAdapter(),
    ]
    return {adapter.provider_id: adapter for adapter in adapters}


def post_json(
    url: str, headers: dict[str, str], body: dict[str, Any], timeout: float
) -> dict[str, Any]:
    data = json.dumps(body).encode("utf-8")
    req = urlrequest.Request(url, data=data, headers=headers, method="POST")
    with urlrequest.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))

"""Hosted-provider transports for the US-107 spike.

Each adapter builds a provider request and parses a provider response.
Normalized tool calls are the only shape the scorer sees. Credentials are
attached only after the destination URL is allowlisted, and redirects are
not followed.
"""

from __future__ import annotations

import ipaddress
import json
import math
import re
from http import client as http_client
from typing import Any
from urllib.parse import urlsplit

from provider_docs import PROVIDERS

from tools import TOOLS

MAX_OUTPUT_TOKENS = 800

OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"

# Pay-as-you-go OpenAI-compatible hosts from Alibaba Cloud Model Studio
# "Base URL overview", last updated 2026-09-28, accessed 2026-10-02:
# https://www.alibabacloud.com/help/en/model-studio/base-url
# Token Plan and Coding Plan hosts are documented as not for backend services.
DASHSCOPE_EXACT_HOSTS = frozenset(
    {
        "dashscope.aliyuncs.com",
        "dashscope-intl.aliyuncs.com",
        "dashscope-us.aliyuncs.com",
        "cn-hongkong.dashscope.aliyuncs.com",
    }
)
DASHSCOPE_TRIAL_HOSTS = frozenset(
    {
        "trial.cn-beijing.maas.aliyuncs.com",
        "trial.ap-southeast-1.maas.aliyuncs.com",
        "trial.cn-hongkong.maas.aliyuncs.com",
    }
)
DASHSCOPE_WORKSPACE_SUFFIXES = (
    ".cn-beijing.maas.aliyuncs.com",
    ".ap-southeast-1.maas.aliyuncs.com",
    ".ap-northeast-1.maas.aliyuncs.com",
    ".eu-central-1.maas.aliyuncs.com",
    ".us-east-1.maas.aliyuncs.com",
    ".cn-hongkong.maas.aliyuncs.com",
)
DASHSCOPE_PATH = "/compatible-mode/v1"
_WORKSPACE_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")

FIXED_PROVIDER_HOSTS = frozenset(
    {
        "api.openai.com",
        "api.anthropic.com",
        "generativelanguage.googleapis.com",
        "api.deepseek.com",
    }
)


class TransportError(Exception):
    """A provider call failed before a JSON object was accepted."""


class RedirectBlocked(TransportError):
    """The provider returned a redirect. It was not followed."""


class EndpointRejected(TransportError):
    """The URL is not an allowlisted provider endpoint."""


def redact(text: str, secrets: list[str]) -> str:
    redacted = text
    for secret in secrets:
        if secret:
            redacted = redacted.replace(secret, "[REDACTED]")
    return redacted


def collect_secrets(*values: object) -> list[str]:
    """Known credential strings, longest first so a shorter key cannot leave a tail."""

    found: list[str] = []

    def add(item: object) -> None:
        if isinstance(item, str):
            if len(item) >= 4:
                found.append(item)
            return
        if isinstance(item, dict):
            for key, value in item.items():
                add(key)
                add(value)
            return
        if isinstance(item, (list, tuple)):
            for value in item:
                add(value)

    for value in values:
        add(value)
    return sorted(set(found), key=len, reverse=True)


def sanitize(value: object, secrets: list[str]) -> object:
    if isinstance(value, str):
        return redact(value, secrets)
    if isinstance(value, dict):
        cleaned: dict[object, object] = {}
        for key, item in value.items():
            redacted_key = redact(key, secrets) if isinstance(key, str) else key
            cleaned[redacted_key] = sanitize(item, secrets)
        return cleaned
    if isinstance(value, list):
        return [sanitize(item, secrets) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def dumps_redacted(payload: object, secrets: list[str]) -> str:
    cleaned = sanitize(payload, secrets)
    text = json.dumps(cleaned, indent=2, allow_nan=False)
    return redact(text, secrets) + "\n"


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


def _host_is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


def dashscope_host_allowed(host: str) -> bool:
    folded = host.lower().rstrip(".")
    if folded in DASHSCOPE_EXACT_HOSTS or folded in DASHSCOPE_TRIAL_HOSTS:
        return True
    for suffix in DASHSCOPE_WORKSPACE_SUFFIXES:
        if not folded.endswith(suffix):
            continue
        label = folded[: -len(suffix)]
        if "." in label or label in {"trial", "token-plan", "coding-intl"}:
            return False
        return _WORKSPACE_LABEL.fullmatch(label) is not None
    return False


def https_provider_host_allowed(host: str) -> bool:
    folded = host.lower().rstrip(".")
    return folded in FIXED_PROVIDER_HOSTS or dashscope_host_allowed(folded)


def dashscope_chat_url(base: str) -> tuple[str, str | None]:
    """Return the chat-completions URL, or an error. Never returns a partial URL."""

    if not isinstance(base, str) or not base.strip():
        return "", (
            "DASHSCOPE_BASE_URL is required. Use a documented HTTPS "
            "OpenAI-compatible Model Studio host."
        )
    raw = base.strip()
    if any(mark in raw for mark in ("\\", " ", "%", "@")):
        return "", "DashScope base URL is not an allowlisted https endpoint"
    parts = urlsplit(raw)
    host = parts.hostname
    if (
        parts.scheme != "https"
        or parts.username is not None
        or parts.password is not None
        or parts.port is not None
        or parts.query
        or parts.fragment
        or host is None
    ):
        return "", "DashScope base URL is not an allowlisted https endpoint"
    if _host_is_ip(host) or not dashscope_host_allowed(host):
        return "", "DashScope base URL is not an allowlisted https endpoint"
    path = parts.path.rstrip("/") or "/"
    if path != DASHSCOPE_PATH:
        return "", "DashScope base URL is not an allowlisted https endpoint"
    return f"https://{host.lower().rstrip('.')}{DASHSCOPE_PATH}/chat/completions", None


def ensure_transport_url(url: str) -> None:
    """Reject destinations before a socket is opened.

    HTTP is allowed only for a loopback test server. Every other call must be
    HTTPS on a fixed provider host or a documented DashScope host.
    """

    parts = urlsplit(url)
    host = parts.hostname
    if host is None or parts.username is not None or parts.password is not None:
        raise EndpointRejected("provider URL is not allowlisted")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None:
        if address.is_loopback and parts.scheme == "http":
            return
        raise EndpointRejected("provider URL is not allowlisted")
    if parts.scheme != "https" or parts.port not in (None, 443):
        raise EndpointRejected("provider URL is not allowlisted")
    if not https_provider_host_allowed(host):
        raise EndpointRejected("provider URL is not allowlisted")


def post_json(
    url: str, headers: dict[str, str], body: dict[str, Any], timeout: float
) -> dict[str, Any]:
    """POST JSON and return an object. Redirects are not followed."""

    ensure_transport_url(url)
    parts = urlsplit(url)
    host = parts.hostname
    if host is None:
        raise EndpointRejected("provider URL is not allowlisted")
    path = parts.path or "/"
    if parts.query:
        path = f"{path}?{parts.query}"
    payload = json.dumps(body).encode("utf-8")
    connection: http_client.HTTPConnection | None = None
    try:
        if parts.scheme == "https":
            connection = http_client.HTTPSConnection(
                host, parts.port or 443, timeout=timeout
            )
        else:
            connection = http_client.HTTPConnection(
                host, parts.port or 80, timeout=timeout
            )
        connection.request("POST", path, body=payload, headers=headers)
        response = connection.getresponse()
        status = response.status
        raw = response.read()
    finally:
        if connection is not None:
            connection.close()
    if 300 <= status < 400:
        raise RedirectBlocked(f"HTTP {status} redirect was not followed")
    if status >= 400:
        raise TransportError(f"HTTP {status}")
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise TransportError("provider response was not JSON") from exc
    if not isinstance(parsed, dict):
        raise TransportError("provider response was not a JSON object")
    return parsed


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

    def output_is_bounded(self, body: dict[str, Any]) -> bool:
        return False


class OpenAIAdapter(ProviderAdapter):
    provider_id = "openai"
    env_var = "OPENAI_API_KEY"

    def request_url(self, options: dict[str, Any] | None = None) -> str:
        return OPENAI_CHAT_URL

    def output_is_bounded(self, body: dict[str, Any]) -> bool:
        # Chat Completions: max_completion_tokens caps visible and reasoning tokens.
        # max_tokens is deprecated. Accessed 2026-10-02.
        return body.get("max_completion_tokens") == MAX_OUTPUT_TOKENS

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
            "max_completion_tokens": MAX_OUTPUT_TOKENS,
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
            "thought_tokens": None,
            "parse_error": None,
        }


class AnthropicAdapter(ProviderAdapter):
    provider_id = "anthropic"
    env_var = "ANTHROPIC_API_KEY"

    def request_url(self, options: dict[str, Any] | None = None) -> str:
        return ANTHROPIC_URL

    def output_is_bounded(self, body: dict[str, Any]) -> bool:
        return body.get("max_tokens") == MAX_OUTPUT_TOKENS

    def build_request(
        self, model: str, prompt: str, options: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return {
            "model": model,
            "max_tokens": MAX_OUTPUT_TOKENS,
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
            "thought_tokens": None,
            "parse_error": None,
        }


class GeminiAdapter(ProviderAdapter):
    provider_id = "gemini"
    env_var = "GEMINI_API_KEY"

    def request_url(self, options: dict[str, Any] | None = None) -> str:
        return GEMINI_URL

    def output_is_bounded(self, body: dict[str, Any]) -> bool:
        # Interactions API: generation_config.max_output_tokens. Accessed 2026-10-02.
        config = body.get("generation_config")
        return (
            isinstance(config, dict)
            and config.get("max_output_tokens") == MAX_OUTPUT_TOKENS
        )

    def build_request(
        self, model: str, prompt: str, options: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return {
            "model": model,
            "input": prompt,
            "tools": _gemini_tools(),
            "generation_config": {"max_output_tokens": MAX_OUTPUT_TOKENS},
        }

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
            "input_tokens": usage.get("total_input_tokens"),
            "output_tokens": usage.get("total_output_tokens"),
            "thought_tokens": usage.get("total_thought_tokens"),
            "parse_error": None,
        }


class QwenAdapter(ProviderAdapter):
    provider_id = "qwen"
    env_var = "DASHSCOPE_API_KEY"

    def request_url(self, options: dict[str, Any] | None = None) -> str:
        url, _error = dashscope_chat_url(_dashscope_base(options))
        return url

    def output_is_bounded(self, body: dict[str, Any]) -> bool:
        # OpenAI-compatible chat completions use max_tokens. Accessed 2026-10-02.
        return body.get("max_tokens") == MAX_OUTPUT_TOKENS

    def build_request(
        self, model: str, prompt: str, options: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        base = _dashscope_base(options)
        url, error = dashscope_chat_url(base)
        if not base.strip():
            return {
                "unsupported": True,
                "reason": (
                    "DASHSCOPE_BASE_URL is required. Set a documented HTTPS "
                    "OpenAI-compatible Model Studio host."
                ),
            }
        if error or not url:
            return {
                "blocked": True,
                "reason": error
                or "DashScope base URL is not an allowlisted https endpoint",
            }
        return {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "tools": _openai_tools(),
            "enable_thinking": False,
            "max_tokens": MAX_OUTPUT_TOKENS,
        }

    def parse_response(self, payload: dict[str, Any]) -> dict[str, Any]:
        return OpenAIAdapter().parse_response(payload)


class DeepSeekAdapter(ProviderAdapter):
    provider_id = "deepseek"
    env_var = "DEEPSEEK_API_KEY"

    def request_url(self, options: dict[str, Any] | None = None) -> str:
        return DEEPSEEK_URL

    def output_is_bounded(self, body: dict[str, Any]) -> bool:
        return body.get("max_tokens") == MAX_OUTPUT_TOKENS

    def build_request(
        self, model: str, prompt: str, options: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "tools": _deepseek_tools(),
            "max_tokens": MAX_OUTPUT_TOKENS,
        }

    def parse_response(self, payload: dict[str, Any]) -> dict[str, Any]:
        return OpenAIAdapter().parse_response(payload)


def _dashscope_base(options: dict[str, Any] | None) -> str:
    if not options:
        return ""
    return str(options.get("dashscope_base_url") or "")


def _responses_only(model: str) -> bool:
    folded = model.lower()
    return "gpt-6" in folded and ("astra" in folded or "sol" in folded)


def _malformed(reason: str) -> dict[str, Any]:
    return {
        "calls": [],
        "input_tokens": None,
        "output_tokens": None,
        "thought_tokens": None,
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

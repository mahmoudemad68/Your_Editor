"""Notes taken from provider documentation on 2026-10-02.

Model ids in these notes are examples published by the provider that day.
The runner does not select them. The owner passes --model.
"""

ACCESSED = "2026-10-02"

PROVIDERS: dict[str, dict[str, object]] = {
    "openai": {
        "documentation_url": "https://developers.openai.com/api/docs/guides/function-calling",
        "accessed": ACCESSED,
        "api": "Chat Completions POST https://api.openai.com/v1/chat/completions",
        "sdk": "none; this benchmark uses urllib",
        "env": "OPENAI_API_KEY",
        "example_model_in_docs": "gpt-5.6-terra",
        "thinking": (
            "Not a universal boolean. This adapter omits reasoning_effort unless "
            "openai_reasoning_effort is set. For gpt-5.6 and gpt-5.6-sol, the model "
            "card documents the omitted default as medium. That default is not a "
            "measurement from this benchmark. The GPT-5.6 Sol upgrade guide says "
            "Chat Completions function tools are compatible only with effective "
            "reasoning none. The request is still sent without reasoning_effort."
        ),
        "thinking_default": {
            "parameter": "reasoning_effort",
            "models": {
                "gpt-5.6": "medium",
                "gpt-5.6-sol": "medium",
            },
            "source_url": "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
            "also_stated_at": "https://developers.openai.com/api/docs/guides/reasoning",
            "tool_constraint_source": (
                "https://developers.openai.com/api/docs/guides/upgrading-to-gpt-5p6-sol"
            ),
            "accessed": ACCESSED,
            "empirically_observed": False,
        },
        "output_limit": "max_completion_tokens, set to the benchmark budget of 800",
        "limitations": [
            "Tool calls are read from choices[0].message.tool_calls.",
            "The guide says GPT-6 Astra and GPT-6.1 Sol require the Responses API.",
            "This adapter does not call the Responses API.",
            "strict is set on each function, matching the Chat Completions example.",
            "max_completion_tokens caps visible and reasoning tokens. Deprecated max_tokens is not sent.",
        ],
    },
    "anthropic": {
        "documentation_url": "https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview",
        "accessed": ACCESSED,
        "api": "POST https://api.anthropic.com/v1/messages",
        "api_version": "2023-06-01",
        "sdk": "none; this benchmark uses urllib",
        "env": "ANTHROPIC_API_KEY",
        "example_model_in_docs": None,
        "thinking": (
            "Not a universal boolean. This request does not send a thinking parameter. "
            "Extended thinking is model-specific and is left unsupported here."
        ),
        "output_limit": "max_tokens, set to the benchmark budget of 800",
        "limitations": [
            "Tools use input_schema, not the OpenAI function wrapper.",
            "Calls are content blocks with type tool_use. input is an object.",
            "Parallel tool use is left at the API default.",
            "max_tokens is the Messages API output cap and matches the 800-token reservation.",
        ],
    },
    "gemini": {
        "documentation_url": "https://ai.google.dev/gemini-api/docs/function-calling",
        "accessed": ACCESSED,
        "api": "POST https://generativelanguage.googleapis.com/v1beta/interactions",
        "sdk": "none; this benchmark uses urllib",
        "env": "GEMINI_API_KEY",
        "example_model_in_docs": "gemini-3.8-flash",
        "thinking": "Not a universal boolean. This Interactions request does not enable a thinking mode.",
        "output_limit": "generation_config.max_output_tokens, set to the benchmark budget of 800",
        "limitations": [
            "The page accessed on 2026-10-02 uses the Interactions API.",
            "Function tools are type function with name and parameters.",
            "Calls are steps with type function_call.",
            "Usage is read from total_input_tokens and total_output_tokens.",
            "total_thought_tokens is added when pricing the response because it is separate from total_output_tokens.",
            "The older generateContent functionDeclarations shape is not what this adapter sends.",
        ],
    },
    "qwen": {
        "documentation_url": "https://help.aliyun.com/en/model-studio/qwen-function-calling",
        "accessed": ACCESSED,
        "api": "OpenAI-compatible POST on an allowlisted Model Studio host /compatible-mode/v1/chat/completions",
        "endpoint_doc": "https://www.alibabacloud.com/help/en/model-studio/base-url",
        "sdk": "none; this benchmark uses urllib",
        "env": "DASHSCOPE_API_KEY",
        "example_model_in_docs": "qwen3.8-max",
        "thinking": (
            "Qwen uses enable_thinking on the request. The guide's example sets it false. "
            "This adapter sends false and does not treat that as a cross-provider switch."
        ),
        "output_limit": "max_tokens on the OpenAI-compatible body, set to the benchmark budget of 800",
        "limitations": [
            "DASHSCOPE_BASE_URL must be a documented HTTPS pay-as-you-go OpenAI-compatible host.",
            "Shared, workspace, and trial hosts from the base URL page accessed 2026-10-02 are allowlisted.",
            "Token Plan and Coding Plan hosts are excluded; those docs say they are not for backend services.",
            "Localhosts, IP addresses, userinfo, custom ports, and other paths are rejected before any request.",
            "There is no default host, because guessing a workspace would be speculative.",
            "Tool call shape matches Chat Completions. Other OpenAI fields are not assumed.",
            "GLM models on the same page need extra settings. This adapter is only the Qwen path.",
        ],
    },
    "deepseek": {
        "documentation_url": "https://api-docs.deepseek.com/guides/tool_calls/",
        "accessed": ACCESSED,
        "api": "POST https://api.deepseek.com/chat/completions",
        "sdk": "none; this benchmark uses urllib",
        "env": "DEEPSEEK_API_KEY",
        "example_model_in_docs": "deepseek-flash",
        "thinking": (
            "Not the same control as Qwen enable_thinking or OpenAI reasoning_effort. "
            "This adapter omits thinking and reasoning_effort. The Chat Completions "
            "reference documents the omitted defaults as thinking enabled and reasoning "
            "effort high. Those defaults are not a measurement from this benchmark."
        ),
        "thinking_default": {
            "parameters": ["thinking", "reasoning_effort"],
            "models": {
                "deepseek-flash": {"thinking": "enabled", "reasoning_effort": "high"},
            },
            "source_url": "https://api-docs.deepseek.com/api/create-chat-completion",
            "accessed": ACCESSED,
            "empirically_observed": False,
        },
        "output_limit": "max_tokens, set to the benchmark budget of 800",
        "limitations": [
            "The non-beta Chat Completions path is used.",
            "strict mode needs https://api.deepseek.com/beta and is not sent.",
            "The Chat Completions API does not support inserting tool calls mid-conversation.",
            "OpenAI-compatible tool_calls are read. Other OpenAI features are not assumed.",
            "max_tokens is the documented Chat Completions output cap and is sent as 800.",
            "Omitting thinking does not disable it. The reference default is enabled.",
        ],
    },
}


def documented_openai_reasoning_default(model: str) -> str | None:
    """Documented omitted reasoning_effort for a model id, or None if unrecorded."""

    catalog = PROVIDERS["openai"].get("thinking_default")
    if not isinstance(catalog, dict):
        return None
    models = catalog.get("models")
    if not isinstance(models, dict):
        return None
    value = models.get(model.strip().lower())
    return value if isinstance(value, str) else None


def documented_deepseek_thinking_default(model: str) -> dict[str, str] | None:
    """Documented omitted thinking settings for a model id, or None if unrecorded."""

    catalog = PROVIDERS["deepseek"].get("thinking_default")
    if not isinstance(catalog, dict):
        return None
    models = catalog.get("models")
    if not isinstance(models, dict):
        return None
    value = models.get(model.strip().lower())
    if not isinstance(value, dict):
        return None
    thinking = value.get("thinking")
    effort = value.get("reasoning_effort")
    if not isinstance(thinking, str) or not isinstance(effort, str):
        return None
    return {"thinking": thinking, "reasoning_effort": effort}

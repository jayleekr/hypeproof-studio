"""Translate OpenAI chat completion request → Anthropic Messages request.

Goals:
- Apply prompt caching to system prompt + tools (5-min ephemeral cache).
- Preserve role semantics: OpenAI "system" → Anthropic system param; assistant/user → messages.
- Stream-aware: caller decides on stream=True; we just produce the request body.
"""

from __future__ import annotations

from typing import Any


# Default model if client doesn't specify. Sonnet is the sweet spot for this poc.
DEFAULT_MODEL = "claude-sonnet-4-6"
DEFAULT_MAX_TOKENS = 4096

# Map OpenAI model aliases to Anthropic IDs. Family workshop tokens map to a
# single backing model regardless of what the client sends.
MODEL_MAP = {
    "hypeproof-default":   "claude-sonnet-4-6",
    "hypeproof-fast":      "claude-haiku-4-5",
    "hypeproof-strong":    "claude-opus-4-7",
    # Pass-through for direct testing
    "claude-sonnet-4-6":   "claude-sonnet-4-6",
    "claude-haiku-4-5":    "claude-haiku-4-5",
    "claude-opus-4-7":     "claude-opus-4-7",
}


def resolve_model(openai_model: str | None) -> str:
    if not openai_model:
        return DEFAULT_MODEL
    return MODEL_MAP.get(openai_model, DEFAULT_MODEL)


def openai_to_anthropic(body: dict[str, Any]) -> dict[str, Any]:
    """Convert OpenAI ChatCompletion body → Anthropic Messages body.

    Adds cache_control breakpoints on system prompt + tool definitions.
    """
    messages_in = body.get("messages", [])
    if not isinstance(messages_in, list):
        raise ValueError("messages must be a list")

    system_parts: list[str] = []
    msgs: list[dict[str, Any]] = []
    for m in messages_in:
        role = m.get("role")
        content = m.get("content", "")
        if role == "system":
            if isinstance(content, str) and content.strip():
                system_parts.append(content)
            continue
        if role not in ("user", "assistant"):
            # Skip unsupported roles (tool, function) — Anthropic equivalents differ
            continue
        if isinstance(content, list):
            # Already structured (multimodal) — pass through
            msgs.append({"role": role, "content": content})
        else:
            msgs.append({"role": role, "content": str(content)})

    out: dict[str, Any] = {
        "model": resolve_model(body.get("model")),
        "messages": msgs,
        "max_tokens": int(body.get("max_tokens") or DEFAULT_MAX_TOKENS),
    }

    if system_parts:
        # Concat as a single cacheable block — common case for HypeProof: one
        # static "you are a friendly coding helper" prompt that doesn't change
        # across a session.
        sys_text = "\n\n".join(system_parts)
        out["system"] = [
            {
                "type": "text",
                "text": sys_text,
                "cache_control": {"type": "ephemeral"},
            }
        ]

    # Tools (if provided) — cache the tool list too. Last tool block gets the
    # cache_control marker per Anthropic's API contract.
    tools_in = body.get("tools")
    if isinstance(tools_in, list) and tools_in:
        tools_out: list[dict[str, Any]] = []
        for i, t in enumerate(tools_in):
            fn = t.get("function") if isinstance(t, dict) else None
            if not fn:
                continue
            spec: dict[str, Any] = {
                "name": fn.get("name", f"tool_{i}"),
                "description": fn.get("description", ""),
                "input_schema": fn.get("parameters") or {"type": "object"},
            }
            tools_out.append(spec)
        if tools_out:
            tools_out[-1]["cache_control"] = {"type": "ephemeral"}
            out["tools"] = tools_out

    # Temperature pass-through where present
    if "temperature" in body:
        out["temperature"] = body["temperature"]

    return out


def anthropic_event_to_openai_sse(event: dict[str, Any]) -> str | None:
    """Convert one parsed Anthropic SSE event → an OpenAI-format SSE `data:` line.

    Returns the data payload (without the trailing \\n\\n) or None if the event
    should not be forwarded (e.g. ping).
    """
    et = event.get("type")
    if et == "content_block_delta":
        delta = event.get("delta") or {}
        text = delta.get("text")
        if text is None:
            return None
        oa = {
            "id": "chatcmpl-hps",
            "object": "chat.completion.chunk",
            "model": event.get("model", "hypeproof"),
            "choices": [
                {
                    "index": 0,
                    "delta": {"content": text},
                    "finish_reason": None,
                }
            ],
        }
        return _json_dumps(oa)
    if et == "message_stop":
        oa = {
            "id": "chatcmpl-hps",
            "object": "chat.completion.chunk",
            "model": event.get("model", "hypeproof"),
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        }
        return _json_dumps(oa)
    # message_start, content_block_start, content_block_stop, ping → drop
    return None


def _json_dumps(obj: dict[str, Any]) -> str:
    import json as _json
    return _json.dumps(obj, ensure_ascii=False, separators=(",", ":"))

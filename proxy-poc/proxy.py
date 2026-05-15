"""HypeProof Proxy — OpenAI-compatible front end for the Anthropic Messages API.

Run:
    HPS_SIGNING_SECRET="..." ANTHROPIC_API_KEY="..." python proxy.py

Endpoints:
    GET  /v1/health
    POST /v1/chat/completions    (OpenAI ChatCompletion, streaming SSE)
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from typing import Any, AsyncIterator

import anthropic
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from tokens import TokenError, verify as verify_token
from translate import anthropic_event_to_openai_sse, openai_to_anthropic, resolve_model


# ---------- Config -----------------------------------------------------------

PORT = int(os.environ.get("HPS_PROXY_PORT", "8787"))
LOG_FILE = os.environ.get("HPS_LOG_FILE", "")
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

if not ANTHROPIC_KEY:
    print("FATAL: ANTHROPIC_API_KEY must be set", file=sys.stderr)
    sys.exit(2)

# ---------- Logging ----------------------------------------------------------

handlers: list[logging.Handler] = [logging.StreamHandler(sys.stderr)]
if LOG_FILE:
    handlers.append(logging.FileHandler(LOG_FILE))
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=handlers,
)
log = logging.getLogger("hps-proxy")

# ---------- App --------------------------------------------------------------

app = FastAPI(title="HypeProof Proxy", version="0.1.0")
client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_KEY)


def _extract_token(authorization: str | None) -> str:
    if not authorization:
        raise HTTPException(401, "Missing Authorization header")
    parts = authorization.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(401, "Authorization must be 'Bearer <token>'")
    return parts[1].strip()


@app.get("/v1/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "service": "hypeproof-proxy", "version": "0.1.0"}


@app.post("/v1/chat/completions")
async def chat_completions(request: Request) -> StreamingResponse | JSONResponse:
    # 1. Auth
    token = _extract_token(request.headers.get("authorization"))
    try:
        payload = verify_token(token)
    except TokenError as exc:
        log.warning("token rejected: %s", exc)
        raise HTTPException(401, str(exc))

    # 2. Parse + translate body
    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(400, f"bad json: {exc}")

    try:
        anth_body = openai_to_anthropic(body)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    stream = bool(body.get("stream", False))
    model = anth_body["model"]
    started = time.time()
    log.info(
        "chat user=%s model=%s stream=%s msgs=%d",
        payload.user_name,
        model,
        stream,
        len(anth_body.get("messages", [])),
    )

    if not stream:
        # Non-streaming path — collect everything, return one OpenAI response
        try:
            msg = await client.messages.create(**anth_body)
        except anthropic.APIError as exc:
            log.error("anthropic error: %s", exc)
            raise HTTPException(502, f"upstream error: {exc}")
        text = "".join(block.text for block in msg.content if block.type == "text")
        log.info(
            "chat ok user=%s tokens_in=%d tokens_out=%d cache_read=%d cache_create=%d t=%.1fs",
            payload.user_name,
            msg.usage.input_tokens,
            msg.usage.output_tokens,
            getattr(msg.usage, "cache_read_input_tokens", 0) or 0,
            getattr(msg.usage, "cache_creation_input_tokens", 0) or 0,
            time.time() - started,
        )
        return JSONResponse({
            "id": msg.id,
            "object": "chat.completion",
            "model": model,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": msg.stop_reason or "stop",
            }],
            "usage": {
                "prompt_tokens": msg.usage.input_tokens,
                "completion_tokens": msg.usage.output_tokens,
                "total_tokens": msg.usage.input_tokens + msg.usage.output_tokens,
            },
        })

    # Streaming path — translate Anthropic SSE → OpenAI SSE
    async def stream_iter() -> AsyncIterator[bytes]:
        try:
            async with client.messages.stream(**anth_body) as anth_stream:
                async for event in anth_stream:
                    # event is a typed object — convert to dict for translator
                    ev_dict = _event_to_dict(event, model)
                    line = anthropic_event_to_openai_sse(ev_dict)
                    if line is not None:
                        yield f"data: {line}\n\n".encode("utf-8")
                # After loop — emit final usage as a server-sent comment for debug
                final = await anth_stream.get_final_message()
                log.info(
                    "chat ok user=%s tokens_in=%d tokens_out=%d cache_read=%d cache_create=%d t=%.1fs",
                    payload.user_name,
                    final.usage.input_tokens,
                    final.usage.output_tokens,
                    getattr(final.usage, "cache_read_input_tokens", 0) or 0,
                    getattr(final.usage, "cache_creation_input_tokens", 0) or 0,
                    time.time() - started,
                )
            yield b"data: [DONE]\n\n"
        except anthropic.APIError as exc:
            log.error("anthropic stream error: %s", exc)
            err = json.dumps({"error": {"message": str(exc), "type": "upstream_error"}})
            yield f"data: {err}\n\n".encode("utf-8")
            yield b"data: [DONE]\n\n"

    return StreamingResponse(
        stream_iter(),
        media_type="text/event-stream",
        headers={
            "cache-control": "no-cache",
            "x-accel-buffering": "no",
        },
    )


def _event_to_dict(event: Any, model: str) -> dict[str, Any]:
    """Convert an anthropic stream event object to the dict shape our translator expects."""
    et = getattr(event, "type", None)
    out: dict[str, Any] = {"type": et, "model": model}
    if et == "content_block_delta":
        delta = getattr(event, "delta", None)
        text = getattr(delta, "text", None) if delta else None
        out["delta"] = {"text": text}
    return out


# ---------- Entrypoint -------------------------------------------------------

def main() -> None:
    import uvicorn

    # Touch the signing secret to fail fast if missing
    from tokens import _signing_secret

    try:
        _signing_secret()
    except TokenError as exc:
        print(f"FATAL: {exc}", file=sys.stderr)
        sys.exit(2)

    log.info(
        "starting on :%d (default model=%s)",
        PORT,
        resolve_model(os.environ.get("HPS_PROXY_MODEL")),
    )
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")


if __name__ == "__main__":
    main()

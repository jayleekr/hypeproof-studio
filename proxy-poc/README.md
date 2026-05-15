# HypeProof Proxy (poc)

OpenAI-compatible HTTP proxy that fronts the Anthropic Messages API. Used by the bundled `hypeproof-chat` extension in HypeProof Studio.

## What it does

- Accepts `POST /v1/chat/completions` (OpenAI format, streaming SSE)
- Forwards to Anthropic's `/v1/messages` with prompt caching (system + tools cached)
- Gates access by **workshop token** (HMAC-signed, expires per workshop session)
- Logs request metadata (no message bodies) for usage tracking

## Run

```bash
cd proxy-poc
python3.11 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt

# Required
export ANTHROPIC_API_KEY=sk-ant-...
export HPS_SIGNING_SECRET="some-long-random-string"   # used to sign workshop tokens

# Optional
export HPS_PROXY_PORT=8787
export HPS_PROXY_MODEL=claude-sonnet-4-6              # default model
export HPS_LOG_FILE=./proxy.log

python proxy.py
```

Health check:
```bash
curl http://localhost:8787/v1/health
```

## Workshop tokens

```bash
# Generate a token valid for 8 hours
python issue_token.py --user-name "참가자A" --hours 8
# → eyJ1IjoiVOixdGtkfslfslkf..."

# Revoke (rotate the signing secret)
export HPS_SIGNING_SECRET="new-secret"
# all old tokens become invalid
```

Family members paste the token into the chat panel ("Set token" button).

## Architecture

```
hypeproof-chat (VS Code webview)
        │  POST /v1/chat/completions  (Bearer <token>)
        ▼
proxy.py
  │ 1. verify token signature + expiry
  │ 2. translate OpenAI messages → Anthropic messages
  │ 3. inject cache_control on system prompt + tools
  │ 4. forward to api.anthropic.com
  │ 5. translate SSE stream back to OpenAI delta format
  ▼
Anthropic Messages API
```

## Production hardening (post-Phase-7)

This is a poc. Before broader release:
- Add per-token rate limiting (currently unlimited)
- Persist usage in SQLite (currently log-only)
- Add `/v1/admin/tokens` endpoint for revocation list
- Run behind Caddy/nginx with TLS
- Add health-based load shedding if Anthropic returns 529

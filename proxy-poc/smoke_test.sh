#!/usr/bin/env bash
# Smoke test against a running HypeProof Proxy.
#
# Prereqs:
#   - Proxy running: `python proxy.py` in another shell
#   - HPS_SIGNING_SECRET set in both shells
#   - ANTHROPIC_API_KEY set in the proxy shell

set -euo pipefail

PROXY="${HPS_PROXY_URL:-http://localhost:8787}"

if ! curl -fsS "$PROXY/v1/health" > /dev/null; then
  echo "ERROR: proxy not reachable at $PROXY"
  echo "Start it: ANTHROPIC_API_KEY=... HPS_SIGNING_SECRET=... python proxy.py"
  exit 1
fi
echo "✓ health"

# Issue a 1h token
TOKEN=$(python3.11 issue_token.py --user-name "smoke-test" --hours 1)
echo "✓ token issued (${TOKEN:0:30}...)"

# Reject without token
HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$PROXY/v1/chat/completions" \
  -H "content-type: application/json" \
  -d '{"model":"hypeproof-default","messages":[{"role":"user","content":"hi"}]}')
if [[ "$HTTP" != "401" ]]; then
  echo "FAIL: expected 401 without token, got $HTTP"; exit 1
fi
echo "✓ rejects unauth (401)"

# Non-streaming request
echo
echo "=== non-streaming ==="
curl -fsS -X POST "$PROXY/v1/chat/completions" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"model":"hypeproof-default","stream":false,"max_tokens":40,"messages":[{"role":"system","content":"Reply in one short Korean sentence."},{"role":"user","content":"안녕"}]}' \
  | python3.11 -m json.tool

# Streaming request — show first 5 chunks
echo
echo "=== streaming (first 5 events) ==="
curl -fsS -X POST "$PROXY/v1/chat/completions" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -N \
  -d '{"model":"hypeproof-default","stream":true,"max_tokens":40,"messages":[{"role":"user","content":"숫자 1부터 5까지 한 줄에 하나씩"}]}' \
  | head -5

echo
echo "Done."

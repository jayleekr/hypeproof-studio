#!/usr/bin/env bash
# Local end-to-end dev stack: wrangler dev + roster + active session + token.
#
# After this prints, you can:
#   1. Open browser → http://localhost:8787   (admin UI; user: leave blank, pass: dev)
#   2. Open HypeProof Studio.app, change settings (instructions printed)
#   3. Paste the token, type "안녕" → expect HypeProof Coach reply
#
# Stop: pkill -f "wrangler dev"

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/worker"

# Pin Node 22
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && . "/opt/homebrew/opt/nvm/nvm.sh" >/dev/null 2>&1
nvm use 22.22.1 --silent >/dev/null 2>&1

# Ensure .dev.vars exists with real Anthropic key
if [[ ! -f .dev.vars ]]; then
  echo "ERROR: worker/.dev.vars missing. Run: source ~/.env && create .dev.vars" >&2
  exit 1
fi

SIGNING=$(grep "^HPS_SIGNING_SECRET=" .dev.vars | cut -d= -f2-)
ADMIN_PASS=$(grep "^HPS_ADMIN_PASSWORD=" .dev.vars | cut -d= -f2-)
if [[ -z "$SIGNING" || -z "$ADMIN_PASS" ]]; then
  echo "ERROR: .dev.vars missing HPS_SIGNING_SECRET or HPS_ADMIN_PASSWORD" >&2
  exit 1
fi

# Stop any previous instance
pkill -f "wrangler dev" 2>/dev/null || true
sleep 1

echo "▶ starting wrangler dev (local miniflare)…"
nohup npx wrangler dev --local --port 8787 > /tmp/wrangler-dev.log 2>&1 &
sleep 2

# Wait until ready
for i in $(seq 1 20); do
  if curl -fsS http://localhost:8787/v1/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! curl -fsS http://localhost:8787/v1/health >/dev/null 2>&1; then
  echo "✗ wrangler dev did not become ready. Tail of log:" >&2
  tail -20 /tmp/wrangler-dev.log >&2
  exit 1
fi

AUTH_B64=$(printf ":%s" "$ADMIN_PASS" | base64)

echo "▶ setting roster…"
curl -fsS -X POST http://localhost:8787/admin/cohorts/sk-biopharm-2026-a/roster \
  -H "Authorization: Basic $AUTH_B64" -H "content-type: application/json" \
  -d '{"users":["kid01","kid02","kid03","jay-test"]}' >/dev/null

echo "▶ starting class window (now → +2h)…"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
END=$(date -u -v+2H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
   || date -u -d "+2 hours" +"%Y-%m-%dT%H:%M:%SZ")
curl -fsS -X POST http://localhost:8787/admin/cohorts/sk-biopharm-2026-a/session \
  -H "Authorization: Basic $AUTH_B64" -H "content-type: application/json" \
  -d "{\"profile_id\":\"sk-biopharm-kids-2026-grade-3-4-s1\",\"starts_at\":\"$NOW\",\"ends_at\":\"$END\"}" >/dev/null

echo "▶ issuing token for 'jay-test'…"
TOKEN=$(HPS_SIGNING_SECRET="$SIGNING" node --experimental-strip-types scripts/issue-token.ts \
  --user jay-test --cohort sk-biopharm-2026-a --profile sk-biopharm-kids-2026-grade-3-4-s1 --hours 2)

cat <<EOF

═══════════════════════════════════════════════════════════════════════
  HypeProof Studio — dev stack ready
═══════════════════════════════════════════════════════════════════════

  Worker:        http://localhost:8787
  Admin UI:      http://localhost:8787/      (basic auth — pass: $ADMIN_PASS)
  Health:        http://localhost:8787/v1/health
  Class window:  $NOW  →  $END  (2 hours)
  Roster:        kid01, kid02, kid03, jay-test

  Workshop token (paste in HypeProof Studio.app):
    $TOKEN

─── How to test in the app ───────────────────────────────────────────

  1. Open the app:
       open "$ROOT/vscodium-base/VSCode-darwin-arm64/HypeProof Studio.app"

  2. In the app: Cmd+, (settings) → search "hypeproofChat" →
     Change "Hypeproof Chat: Proxy Url" to:
       http://localhost:8787/v1

  3. Open Command Palette (Cmd+Shift+P) →
     "HypeProof Chat: Set Workshop Token" → paste the token above

  4. Click the 💬 icon on the left → type "안녕"
     → Expect HypeProof Coach reply in Korean

─── Direct curl test (no app needed) ────────────────────────────────

  curl -N -X POST http://localhost:8787/v1/chat/completions \\
    -H "authorization: Bearer $TOKEN" \\
    -H "content-type: application/json" \\
    -d '{"model":"hypeproof-default","stream":true,"max_tokens":200,
         "messages":[{"role":"user","content":"삼각형이 점프하는 게임 만들어줘"}]}'

─── Stop ────────────────────────────────────────────────────────────

  pkill -f "wrangler dev"
  Logs: tail -f /tmp/wrangler-dev.log

═══════════════════════════════════════════════════════════════════════
EOF

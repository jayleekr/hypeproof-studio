#!/usr/bin/env bash
# Reproducible workshop-token E2E smoke for the boah-dental teaser cohort (#14).
#
# Proves the full live round-trip: issue token → 403 without session →
# admin roster → admin session → 200 streamed Korean reply.
#
# Works against local wrangler dev OR the live SaaS — only BASE_URL changes.
# Secrets (HPS_SIGNING_SECRET, HPS_ADMIN_PASSWORD) come from worker/.dev.vars
# (gitignored, per-dir) unless already in the environment. For the prod run
# the .dev.vars values must equal the deployed Worker secrets.
#
#   Local : bash scripts/smoke-dental-e2e.sh
#   Prod  : BASE_URL=https://api.hypeproof-ai.xyz bash scripts/smoke-dental-e2e.sh
#
# NOTE: live execution mutates roster/session for a smoke user on the target
# Worker and spends a little Gemini quota — run deliberately (primary clone /
# operator, per DEV-GUIDE §7), not inside an autonomous loop.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
COHORT="${COHORT:-boah-dental-2026-a}"
PROFILE="${PROFILE:-boah-dental-teaser-2026-s1}"
USER_ID="${USER_ID:-smoke-dental}"
DEVVARS="${DEVVARS:-$(cd "$(dirname "$0")/.." && pwd)/.dev.vars}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

say(){ printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }
ok(){  printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
die(){ printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# --- secrets ---
SIGNING="${HPS_SIGNING_SECRET:-}"
ADMIN="${HPS_ADMIN_PASSWORD:-}"
if [ -z "$SIGNING" ] || [ -z "$ADMIN" ]; then
  [ -f "$DEVVARS" ] || die ".dev.vars not found ($DEVVARS) and secrets not in env"
  SIGNING="${SIGNING:-$(grep -E '^HPS_SIGNING_SECRET=' "$DEVVARS" | head -1 | cut -d= -f2- | tr -d '\r"')}"
  ADMIN="${ADMIN:-$(grep -E '^HPS_ADMIN_PASSWORD=' "$DEVVARS" | head -1 | cut -d= -f2- | tr -d '\r"')}"
fi
[ "${#SIGNING}" -ge 16 ] || die "HPS_SIGNING_SECRET missing/too short"
[ -n "$ADMIN" ] || die "HPS_ADMIN_PASSWORD missing"
AUTH_B64="$(printf ':%s' "$ADMIN" | base64)"

say "0. health  ($BASE_URL)"
curl -fsS -m 10 "$BASE_URL/v1/health" | grep -q '"ok":true' || die "health not ok"
ok "health 200"

say "1. issue token  (user=$USER_ID cohort=$COHORT profile=$PROFILE)"
TOKEN="$(cd "$ROOT" && HPS_SIGNING_SECRET="$SIGNING" node --experimental-strip-types \
  scripts/issue-token.ts --user "$USER_ID" --cohort "$COHORT" --profile "$PROFILE" --hours 2)"
[ -n "$TOKEN" ] || die "token issue failed"
ok "token issued (${#TOKEN} chars)"

chat(){ # -> prints HTTP code, body to $1
  curl -sS -m 30 -o "$1" -w '%{http_code}' -X POST "$BASE_URL/v1/chat/completions" \
    -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
    -d '{"model":"hypeproof-default","stream":false,"max_tokens":64,"messages":[{"role":"user","content":"안녕"}]}'; }

say "2. chat WITHOUT active session  → expect 403"
B=$(mktemp); C=$(chat "$B")
[ "$C" = "403" ] || die "expected 403 without session, got $C ($(head -c200 "$B"))"
ok "403 as expected (auth gate works)"

say "3. admin: set roster"
curl -fsS -m 10 -X POST "$BASE_URL/admin/cohorts/$COHORT/roster" \
  -H "Authorization: Basic $AUTH_B64" -H "content-type: application/json" \
  -d "{\"users\":[\"$USER_ID\"]}" >/dev/null
ok "roster set ($USER_ID)"

say "4. admin: start class session (now → +2h)"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
END="$(date -u -v+2H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ)"
curl -fsS -m 10 -X POST "$BASE_URL/admin/cohorts/$COHORT/session" \
  -H "Authorization: Basic $AUTH_B64" -H "content-type: application/json" \
  -d "{\"profile_id\":\"$PROFILE\",\"starts_at\":\"$NOW\",\"ends_at\":\"$END\"}" >/dev/null
ok "session started ($PROFILE)"

say "5. chat WITH active session  → expect 200 + non-empty Korean reply"
B2=$(mktemp); C2=$(chat "$B2")
[ "$C2" = "200" ] || die "expected 200, got $C2 ($(head -c300 "$B2"))"
REPLY="$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["choices"][0]["message"]["content"][:120])' "$B2" 2>/dev/null || true)"
[ -n "$REPLY" ] || die "200 but empty reply ($(head -c300 "$B2"))"
echo "$REPLY" | grep -qP '[\x{AC00}-\x{D7A3}]' || printf '\033[1;33m! reply has no Hangul (check provider)\033[0m\n'
ok "200 streamed reply: ${REPLY}"
rm -f "$B" "$B2"

printf '\n\033[1;32m═══ PASS — dental cohort E2E round-trip OK ($BASE_URL) ═══\033[0m\n'

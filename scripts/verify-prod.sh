#!/usr/bin/env bash
# Prod smoke — verify api.hypeproof-ai.xyz behaves like dev-stack after a
# worker deploy or profile change. Three layers:
#
#   1. Unauthenticated  /v1/health           — Worker boots
#   2. Admin-auth       /v1/health/deep      — LLM provider + KV + D1
#   3. Cohort-token     /v1/profile + chat   — system prompt + per-cohort UX
#
# Usage:
#   bash scripts/verify-prod.sh                       # layer 1 only
#   HPS_ADMIN_PASSWORD=… bash scripts/verify-prod.sh  # + layer 2
#   TOKEN=… HPS_ADMIN_PASSWORD=… bash …               # + layer 3
#   SKIP_CHAT=1 TOKEN=… bash …                        # profile-only L3
#
# Layer 3 takes a cohort token via the TOKEN env var. Mint one in advance:
#   - via /issuer (instructor flow) on api.hypeproof-ai.xyz/issuer/, OR
#   - via local issue-token.ts with prod HPS_SIGNING_SECRET (privileged)

set -euo pipefail
PROD="${PROD:-https://api.hypeproof-ai.xyz}"
COHORT="${HPS_COHORT:-boah-dental-2026-a}"
PROFILE="${HPS_PROFILE:-boah-dental-teaser-2026-s1}"

ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
note() { printf '\033[36m▸ %s\033[0m\n' "$*"; }

# ─── Layer 1 ─────────────────────────────────────────────────────────
note "L1 — public health"
health="$(curl -fsS --max-time 10 "$PROD/v1/health")" || die "L1: /v1/health unreachable"
echo "  $health" | head -1
echo "$health" | grep -q '"ok":true' || die "L1: health did not return ok=true"
ok "L1 — worker live"

# ─── Layer 2 (optional) ──────────────────────────────────────────────
if [[ -n "${HPS_ADMIN_PASSWORD:-}" ]]; then
  note "L2 — deep health (LLM + KV + D1)"
  AUTH="$(printf ':%s' "$HPS_ADMIN_PASSWORD" | base64)"
  deep="$(curl -fsS --max-time 15 -H "Authorization: Basic $AUTH" "$PROD/v1/health/deep" || true)"
  if [[ -z "$deep" ]]; then
    warn "L2: /v1/health/deep returned nothing (Cloudflare Access? wrong password?)"
  else
    echo "  $(echo "$deep" | python3 -c 'import sys,json; d=json.load(sys.stdin); print({k:v.get("ok") if isinstance(v,dict) else v for k,v in d.items()})')"
    echo "$deep" | grep -q '"gemini"' || warn "L2: gemini block missing"
    echo "$deep" | grep -q '"anthropic"\|"anthropic_proxy"' || warn "L2: anthropic block missing"
    echo "$deep" | grep -q '"kv"' || warn "L2: kv block missing"
    echo "$deep" | grep -q '"d1"' || warn "L2: d1 block missing"
    ok "L2 — deep health responding"
  fi
else
  warn "L2 skipped (HPS_ADMIN_PASSWORD not set)"
fi

# ─── Layer 3 (optional) ──────────────────────────────────────────────
if [[ -n "${TOKEN:-}" ]]; then
  note "L3 — cohort profile + chat shape (cohort=$COHORT)"

  # 3a. /v1/profile must return v4 dental contract
  profile="$(curl -fsS --max-time 10 -H "authorization: Bearer $TOKEN" "$PROD/v1/profile")"
  echo "  profile_id=$(echo "$profile" | python3 -c 'import sys,json; print(json.load(sys.stdin)["profile_id"])')"
  echo "$profile" | grep -q "슈퍼서치엔진" || die "L3a: greeting missing '슈퍼서치엔진' — wrong profile or stale deploy"
  echo "$profile" | grep -q "원장님을 이겨" || die "L3a: greeting missing '원장님을 이겨'"
  asset_count="$(echo "$profile" | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("assets_focus", [])))')"
  [[ "$asset_count" == "7" ]] || die "L3a: assets_focus count is $asset_count, expected 7"
  follow_count="$(echo "$profile" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["ux"]["suggestions"]["follow_up"]))')"
  [[ "$follow_count" == "0" ]] || die "L3a: follow_up chip count is $follow_count, expected 0 after #174/#187 chip cleanup"
  ok "L3a — /v1/profile reflects v4 dental contract"

  # 3b. /v1/chat/completions must respect cohort system prompt (no game vocab)
  if [[ "${SKIP_CHAT:-0}" == "1" ]]; then
    warn "L3b skipped (SKIP_CHAT=1)"
    echo
    ok "verify-prod done"
    exit 0
  fi
  note "L3b — sample chat turn (1 LLM call ≈ $0.002)"
  chat="$(curl -fsS --max-time 60 -X POST \
    -H "authorization: Bearer $TOKEN" \
    -H "content-type: application/json" \
    --data '{"model":"hypeproof-default","stream":false,"max_tokens":200,
             "messages":[{"role":"user","content":"안녕하세요"}]}' \
    "$PROD/v1/chat/completions")"
  reply="$(echo "$chat" | python3 -c 'import sys,json; print(json.load(sys.stdin)["choices"][0]["message"]["content"])' 2>/dev/null || echo "$chat")"
  printf "  reply: %s…\n" "$(echo "$reply" | head -c 120)"
  if echo "$reply" | grep -qE '공이 좌우|별이 떨어|캐릭터.{0,8}장애물|점프하는 게임|게임을 만들'; then
    die "L3b: response contains v3 game vocab — system prompt not live"
  fi
  ok "L3b — chat shape clean (no v3 game vestige)"
else
  warn "L3 skipped (TOKEN env var not set)"
  cat <<HINT
  To run L3, mint a prod cohort token and re-run:
    TOKEN="\$(...)" HPS_ADMIN_PASSWORD=… bash scripts/verify-prod.sh
HINT
fi

echo
ok "verify-prod done"

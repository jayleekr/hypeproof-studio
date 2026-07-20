#!/usr/bin/env bash
# Issue a student token for the boah-dental-2026-a cohort.
#
# Usage:   worker/scripts/issue-boah-student.sh <track> <handle> [hours]
#   track:  copyclone | teaser   (REQUIRED — no default: a silent teaser
#           default opened the wrong track on 2026-07-18, #353)
#   handle: REQUIRED (same silent-default class as track — review on #354)
#   hours:  default 12
#
# Requires: ~/.hypeproof/issuer-token   (chmod 600, NOT tracked)
#       or HPS_ISSUER_TOKEN env var.
#
# Prefer the web console for lecture-day ops: https://api.hypeproof-ai.xyz/console

set -euo pipefail

case "${1:-}" in
  copyclone) PROFILE="boah-dental-director-copyclone-2026-s1" ;;  # 원장 홈페이지 만들기
  teaser)    PROFILE="boah-dental-teaser-2026-s1" ;;              # 직원 "원장님을 이겨라" 검색엔진
  *)
    echo "usage: $0 <copyclone|teaser> <handle> [hours]" >&2
    echo "  copyclone = 원장 웹사이트 카피클론 (홈페이지 만들기)" >&2
    echo "  teaser    = 직원 티저 '원장님을 이겨라' (검색엔진)" >&2
    exit 2
    ;;
esac

HANDLE="${2:-}"
if [[ -z "$HANDLE" ]]; then
  echo "handle required: $0 $1 <handle> [hours]" >&2
  exit 2
fi

TOKEN_FILE="$HOME/.hypeproof/issuer-token"
ISSUER="${HPS_ISSUER_TOKEN:-}"
TOKEN_SOURCE="HPS_ISSUER_TOKEN env"
if [[ -z "$ISSUER" && -f "$TOKEN_FILE" ]]; then
  ISSUER=$(cat "$TOKEN_FILE")
  TOKEN_SOURCE="$TOKEN_FILE"
fi
if [[ -z "$ISSUER" ]]; then
  echo "issuer token missing — write it to $TOKEN_FILE or export HPS_ISSUER_TOKEN" >&2
  exit 2
fi

HOURS="${3:-12}"

RESP=$(curl -sS -X POST https://api.hypeproof-ai.xyz/admin/tokens/issue \
  -H "Authorization: Bearer $ISSUER" \
  -H 'content-type: application/json' \
  -d "{\"u\":\"$HANDLE\",\"c\":\"boah-dental-2026-a\",\"p\":\"$PROFILE\",\"hours\":$HOURS}")

if ! TOKEN=$(printf '%s' "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])' 2>/dev/null); then
  echo "issue failed. Server said:" >&2
  printf '%s\n' "$RESP" >&2
  case "$RESP" in
    *expired*)   echo "→ issuer 토큰 만료. Jay에게 재발급 요청." >&2 ;;
    *revoked*)   echo "→ issuer 토큰이 무효화됨. Jay에게 새 토큰 요청." >&2 ;;
    *"not scoped"*|*can_start_session*)
      echo "→ 구버전/스코프 부족 토큰일 가능성 (사용된 토큰: $TOKEN_SOURCE — 2026-07-18에 구버전 파일 토큰으로 403 났음)." >&2 ;;
  esac
  exit 1
fi
# #367 — the chat gate requires roster membership on top of a valid token;
# register the handle so the minted token actually works. Best-effort: token
# already exists either way, so a failure here is a loud warning, not fatal.
ROSTER=$(curl -sS -X POST "https://api.hypeproof-ai.xyz/admin/cohorts/boah-dental-2026-a/roster/append" \
  -H "Authorization: Bearer $ISSUER" \
  -H 'content-type: application/json' \
  -d "{\"users\":[\"$HANDLE\"]}") || ROSTER=""
if ! printf '%s' "$ROSTER" | grep -q '"ok":true'; then
  echo "WARN: roster append failed for '$HANDLE' — 학생이 not_in_roster로 차단됩니다. 콘솔에서 재시도: $ROSTER" >&2
fi
printf '%s\n' "$TOKEN"

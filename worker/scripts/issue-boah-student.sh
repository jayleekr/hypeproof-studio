#!/usr/bin/env bash
# Issue a student token for the boah-dental-2026-a cohort.
#
# Usage:   worker/scripts/issue-boah-student.sh <track> [handle] [hours]
#   track:  copyclone | teaser   (REQUIRED — no default: a silent teaser
#           default opened the wrong track on 2026-07-18, #353)
#   handle: default jiwoong      hours: default 12
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
    echo "usage: $0 <copyclone|teaser> [handle] [hours]" >&2
    echo "  copyclone = 원장 웹사이트 카피클론 (홈페이지 만들기)" >&2
    echo "  teaser    = 직원 티저 '원장님을 이겨라' (검색엔진)" >&2
    exit 2
    ;;
esac

TOKEN_FILE="$HOME/.hypeproof/issuer-token"
ISSUER="${HPS_ISSUER_TOKEN:-}"
[[ -z "$ISSUER" && -f "$TOKEN_FILE" ]] && ISSUER=$(cat "$TOKEN_FILE")
if [[ -z "$ISSUER" ]]; then
  echo "issuer token missing — write it to $TOKEN_FILE or export HPS_ISSUER_TOKEN" >&2
  exit 2
fi

HANDLE="${2:-jiwoong}"
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
      echo "→ 구버전/스코프 부족 토큰일 가능성 ($TOKEN_FILE 확인 — 2026-07-18에 이걸로 403 났음)." >&2 ;;
  esac
  exit 1
fi
printf '%s\n' "$TOKEN"

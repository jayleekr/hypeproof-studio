#!/usr/bin/env bash
# Issue (or reissue) issuer tokens for the HypeProof teaching team.
#
# Every member who teaches needs their OWN issuer token: student tokens last
# 24h by default, so a team where only one person can mint them has a daily
# bottleneck (#376, the leftover operating step from #295).
#
# Usage:
#   worker/scripts/issue-team-issuers.sh <cohort> [handle...]            # dry-run
#   worker/scripts/issue-team-issuers.sh <cohort> --apply                # issue all defaults
#   worker/scripts/issue-team-issuers.sh <cohort> --apply --minter H1,H2 # grant minters
#   worker/scripts/issue-team-issuers.sh <cohort> --apply --reissue      # replace live tokens
#
#   cohort: REQUIRED — boah-dental-2026-a | sk-biopharm-2026-a
#           (no default: a silent cohort/track default opened the wrong track
#            on 2026-07-18, #353 — the same class of bug applies here)
#
# Auth: admin Basic only. Export HPS_ADMIN_PASSWORD (never paste it as an arg —
# argv is visible to other processes and lands in shell history).
#
# Tokens are NEVER printed. Each one is written to
# ~/.hypeproof/issued/<cohort>/<handle>.token (mode 600); hand them to members
# individually. Do not post tokens in Slack/issues/screenshots — a leaked token
# is usable by anyone until revoked (POST /admin/tokens/revoke with its jti).

set -euo pipefail

API="${HPS_API_BASE:-https://api.hypeproof-ai.xyz}"

# Active teaching members (policy/members.yaml in hypeproof-harness).
DEFAULT_HANDLES=(jayleekr JeHyeong2 ico1036 xoqhdgh1002 JinyongShin TJ-kr)

DAYS="${HPS_ISSUER_DAYS:-60}"      # server cap: 90
MAX_HOURS="${HPS_MAX_HOURS:-12}"   # student token ceiling; server cap: 168
MAX_SESSION_HOURS="${HPS_MAX_SESSION_HOURS:-4}"  # server cap: 24

usage() {
  sed -n '/^# /{s/^# \{0,1\}//;p;}; /^[^#]/q' "$0"
  exit 2
}

COHORT="${1:-}"
case "$COHORT" in
  boah-dental-2026-a)
    PROFILES='["boah-dental-director-copyclone-2026-s1","boah-dental-teaser-2026-s1"]' ;;
  sk-biopharm-2026-a)
    PROFILES='["sk-biopharm-kids-2026-grade-3-4-s1","sk-biopharm-kids-2026-grade-5-6-s1"]' ;;
  --help|-h|"") usage ;;
  *)
    echo "unknown cohort: $COHORT" >&2
    echo "  known: boah-dental-2026-a | sk-biopharm-2026-a" >&2
    exit 2 ;;
esac
shift

APPLY=0
REISSUE=0
MINTERS=""
HANDLES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --apply)   APPLY=1 ;;
    --reissue) REISSUE=1 ;;
    --minter)  MINTERS="${2:-}"; shift ;;
    --help|-h) usage ;;
    -*)        echo "unknown flag: $1" >&2; exit 2 ;;
    *)         HANDLES+=("$1") ;;
  esac
  shift
done
[ "${#HANDLES[@]}" -eq 0 ] && HANDLES=("${DEFAULT_HANDLES[@]}")

if [ -z "${HPS_ADMIN_PASSWORD:-}" ]; then
  echo "HPS_ADMIN_PASSWORD not set — issuer minting needs admin Basic auth." >&2
  echo "  export HPS_ADMIN_PASSWORD='...'   (do not pass it as an argument)" >&2
  exit 2
fi

is_minter() {
  case ",$MINTERS," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

# --- existing issuers: skip anyone already covered, unless --reissue ---------
EXISTING="$(curl -sS -u "admin:$HPS_ADMIN_PASSWORD" "$API/admin/issuers?limit=1000")"
if ! printf '%s' "$EXISTING" | python3 -c 'import json,sys; json.load(sys.stdin)["issuers"]' 2>/dev/null; then
  echo "could not read $API/admin/issuers — check HPS_ADMIN_PASSWORD. Server said:" >&2
  printf '%s\n' "$EXISTING" | head -3 >&2
  exit 1
fi

# live_jti <handle> -> prints the jti of a live (unexpired, unrevoked) issuer
# for this cohort, or nothing.
live_jti() {
  printf '%s' "$EXISTING" | python3 -c '
import json, sys
handle, cohort = sys.argv[1], sys.argv[2]
for i in json.load(sys.stdin)["issuers"]:
    if (i.get("instructor") == handle and not i.get("expired")
            and not i.get("revoked") and cohort in (i.get("cohorts") or [])):
        print(i["jti"]); break
' "$1" "$COHORT"
}

OUT_DIR="$HOME/.hypeproof/issued/$COHORT"
[ "$APPLY" -eq 1 ] && mkdir -p "$OUT_DIR" && chmod 700 "$HOME/.hypeproof/issued" "$OUT_DIR"

printf 'cohort=%s days=%s max_hours=%s max_session_hours=%s apply=%s reissue=%s\n\n' \
  "$COHORT" "$DAYS" "$MAX_HOURS" "$MAX_SESSION_HOURS" "$APPLY" "$REISSUE"

issued=0; skipped=0; failed=0
for HANDLE in "${HANDLES[@]}"; do
  JTI="$(live_jti "$HANDLE")"
  MINTER_FLAG=""
  is_minter "$HANDLE" && MINTER_FLAG=' "can_issue_issuers": true,'

  if [ -n "$JTI" ] && [ "$REISSUE" -eq 0 ]; then
    printf 'SKIP   %-14s already has a live issuer for %s\n' "$HANDLE" "$COHORT"
    skipped=$((skipped + 1))
    continue
  fi

  BODY="{\"instructor\":\"$HANDLE\",\"days\":$DAYS,${MINTER_FLAG}\"scopes\":[{\"cohort\":\"$COHORT\",\"profiles\":$PROFILES,\"max_hours\":$MAX_HOURS,\"can_start_session\":true,\"max_session_hours\":$MAX_SESSION_HOURS}]"
  # Replacing a live token is atomic: the old jti dies only after the new mint
  # succeeds, so a failure leaves the member with their existing token.
  [ -n "$JTI" ] && BODY="$BODY,\"revoke_jti\":\"$JTI\""
  BODY="$BODY}"

  if [ "$APPLY" -eq 0 ]; then
    printf 'DRY    %-14s would issue%s%s\n' "$HANDLE" \
      "$([ -n "$MINTER_FLAG" ] && echo ' (minter)')" \
      "$([ -n "$JTI" ] && echo " replacing ${JTI:0:8}…")"
    continue
  fi

  RESP="$(curl -sS -u "admin:$HPS_ADMIN_PASSWORD" -X POST "$API/admin/issuers" \
    -H 'content-type: application/json' -d "$BODY")"

  # The token exists ONLY in this response body — write it straight to a
  # 600 file and never echo it.
  if printf '%s' "$RESP" | python3 -c '
import json, sys, pathlib, os
d = json.load(sys.stdin)
if "token" not in d:
    sys.exit(1)
p = pathlib.Path(sys.argv[1])
p.write_text(d["token"])
os.chmod(p, 0o600)
print(d.get("jti", ""))
' "$OUT_DIR/$HANDLE.token" > /tmp/.hps_jti_$$ 2>/dev/null; then
    printf 'OK     %-14s -> %s (jti %s)%s\n' "$HANDLE" "$OUT_DIR/$HANDLE.token" \
      "$(cut -c1-8 < /tmp/.hps_jti_$$)" "$([ -n "$MINTER_FLAG" ] && echo ' [minter]')"
    issued=$((issued + 1))
  else
    printf 'FAIL   %-14s server said: %s\n' "$HANDLE" "$(printf '%s' "$RESP" | head -c 200)" >&2
    failed=$((failed + 1))
  fi
  rm -f /tmp/.hps_jti_$$
done

printf '\nissued=%s skipped=%s failed=%s\n' "$issued" "$skipped" "$failed"
if [ "$APPLY" -eq 1 ] && [ "$issued" -gt 0 ]; then
  printf 'Tokens are in %s (mode 600).\n' "$OUT_DIR"
  printf 'Hand each file to its owner privately — never paste a token in Slack, an issue, or a screenshot.\n'
  printf 'Recipients install it as: mkdir -p ~/.hypeproof && cp <file> ~/.hypeproof/issuer-token && chmod 600 ~/.hypeproof/issuer-token\n'
  printf 'Or paste it into the web console: %s/console\n' "$API"
fi
[ "$failed" -gt 0 ] && exit 1
exit 0

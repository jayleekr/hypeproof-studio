#!/usr/bin/env bash
# SDK request-shape contract against the LIVE gateway (#406, tests/rehearsal R7).
#
# The check itself is tests/rehearsal/07-sdk-request-shape.test.mjs. This script
# is the part that makes it runnable unattended: the gateway's chat gate needs
# an open session + a rostered user, so we open a short session on the CANARY
# cohort (empty roster, hidden from the console — worker/src/profiles/
# canary-sdk-contract.ts), run the tests, and close it again. The real classroom
# cohorts are never touched.
#
# Why it must run against prod and not a mock: the failure it guards (#406) was
# an UPSTREAM 400 — the gateway pinned the model but forwarded the client's
# model-generation params. A mocked upstream answers 200 to any body, which is
# exactly why the unit suite stayed green for weeks while every agent-sdk turn
# in the classroom died silently (#403).
#
# Usage:
#   HPS_CANARY_ISSUER=… bash scripts/run-sdk-contract.sh     # preferred
#   HPS_ADMIN_PASSWORD=… bash scripts/run-sdk-contract.sh    # also works
# Env — EITHER credential opens the canary session; neither present → SKIP:
#   HPS_CANARY_ISSUER   PREFERRED. An issuer token scoped to ONLY
#                       (canary-internal, canary-sdk-contract) with
#                       can_start_session. Least privilege: it cannot touch a
#                       real cohort even if the runner leaks it. Mint per
#                       worker/scripts/issue-issuer-token.ts.
#   HPS_ADMIN_PASSWORD  Fallback. Admin Basic is full admin over every cohort —
#                       works, but it is a much bigger credential to hand a CI
#                       runner for the sake of one canary session.
#   PROD                default https://api.hypeproof-ai.xyz
#   CANARY_COHORT       default canary-internal
#   CANARY_PROFILE      default canary-sdk-contract

set -uo pipefail

PROD="${PROD:-https://api.hypeproof-ai.xyz}"
COHORT="${CANARY_COHORT:-canary-internal}"
PROFILE="${CANARY_PROFILE:-canary-sdk-contract}"
USER_ID="ci-sdk-contract"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
note() { printf '\033[36m▸ %s\033[0m\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

if [[ -n "${HPS_CANARY_ISSUER:-}" ]]; then
  AUTH="Bearer $HPS_CANARY_ISSUER"
  note "auth: canary-scoped issuer token"
elif [[ -n "${HPS_ADMIN_PASSWORD:-}" ]]; then
  AUTH="Basic $(printf ':%s' "$HPS_ADMIN_PASSWORD" | base64)"
  note "auth: admin Basic (broader than needed — prefer HPS_CANARY_ISSUER)"
else
  printf '\033[33m! neither HPS_CANARY_ISSUER nor HPS_ADMIN_PASSWORD is set — skipping the SDK contract check\033[0m\n'
  printf '\033[33m  (mint a canary-scoped issuer per scripts/run-sdk-contract.sh header, then add it as a repo secret)\033[0m\n'
  exit 0
fi
JTI=""

# Always close the session, even when the tests fail or the runner is cancelled.
# A canary session left open is harmless (empty roster) but it would make the
# next run's open-guard 409.
cleanup() {
  [[ -z "$JTI" ]] && return 0
  note "closing canary session"
  curl -sS -X POST "$PROD/admin/cohorts/$COHORT/session/close" \
    -H "Authorization: $AUTH" -H 'content-type: application/json' \
    -d "{\"jti\":\"$JTI\"}" >/dev/null 2>&1 && ok "canary session closed + token revoked"
}
trap cleanup EXIT INT TERM

note "opening a 1h canary session ($COHORT / $PROFILE)"
# force:true — a previous run that was hard-killed before its trap could leave a
# live session behind. Clobbering is safe HERE and only here: nobody is on this
# cohort's roster. Never pass force on a real cohort (#291).
OPEN="$(curl -sS -X POST "$PROD/admin/cohorts/$COHORT/session/open" \
  -H "Authorization: $AUTH" -H 'content-type: application/json' \
  -d "{\"profile_id\":\"$PROFILE\",\"user\":\"$USER_ID\",\"session_hours\":1,\"token_hours\":1,\"force\":true}")" \
  || die "session/open request failed"

TOKEN="$(printf '%s' "$OPEN" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)"
JTI="$(printf '%s' "$OPEN" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("jti",""))' 2>/dev/null)"
[[ -n "$TOKEN" && -n "$JTI" ]] || die "session/open did not return a token (response: ${OPEN:0:300})"
ok "canary session open"

note "R7 — SDK request shape vs the live gateway"
cd "$REPO_ROOT/tests/rehearsal" || die "rehearsal tests not found"
TOKEN="$TOKEN" WORKER_URL="$PROD/v1" node --test 07-sdk-request-shape.test.mjs
STATUS=$?

if [[ $STATUS -ne 0 ]]; then
  die "SDK request-shape contract FAILED — the gateway is rejecting what the Agent SDK actually sends. Every agent-sdk coach turn is 400ing (and the SDK hides it behind its retry loop, so students just see an endless spinner). See worker/src/routes/messages.ts MODEL_GATED_PARAMS."
fi
ok "SDK request-shape contract passed"

#!/usr/bin/env bash
# JY dev review: one command from PR number to Dev app window.
# Usage: bash scripts/review-pr.sh <PR-number-or-branch> [--provider claude|codex|service]
# Wraps studio-dev.py; never touches production values.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PROVIDER="service"
INPUT="${1:-}"
WRANGLER_PORT=8787

if [[ -z "$INPUT" ]]; then
  echo "Usage: bash scripts/review-pr.sh <PR-number-or-branch> [--provider claude|codex|service]" >&2
  exit 1
fi
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider) PROVIDER="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Pre-flight checks (before any network calls) ──────────────────────────────
if lsof -iTCP:"$WRANGLER_PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  HOLDER="$(lsof -iTCP:$WRANGLER_PORT -sTCP:LISTEN -Fp 2>/dev/null | grep '^p' | head -1 | sed 's/^p//')"
  echo "ERROR: port $WRANGLER_PORT already in use by PID $HOLDER ($(ps -p "$HOLDER" -o comm= 2>/dev/null || echo unknown))" >&2
  echo "Kill it first or close the other session." >&2
  exit 1
fi

if [[ "${HYPEPROOF_API_URL:-}" == *"hypeproof-ai.xyz"* ]] || \
   [[ "${CF_WORKERS_URL:-}" == *"hypeproof-ai.xyz"* ]]; then
  echo "ERROR: production URL detected in environment. Refusing to start." >&2
  exit 1
fi

# ── Resolve branch from PR number ─────────────────────────────────────────────
if [[ "$INPUT" =~ ^[0-9]+$ ]]; then
  BRANCH="$(gh pr view "$INPUT" --repo jayleekr/hypeproof-studio --json headRefName --jq '.headRefName')"
  echo "PR #$INPUT → branch: $BRANCH"
else
  BRANCH="$INPUT"
fi

SAFE_BRANCH="${BRANCH//\//-}"
TMP_BASE="${TMPDIR:-/tmp}"; TMP_BASE="${TMP_BASE%/}"
WORKTREE_DIR="$TMP_BASE/studio-review-${SAFE_BRANCH}"

# macOS BSD date does not support %N; use python3 for millisecond timestamps.
ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

cleanup() {
  echo ""
  echo "=== Cleanup ==="
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Stopping wrangler dev (PID $SERVER_PID)..."
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  pkill -f "wrangler dev.*--port $WRANGLER_PORT" 2>/dev/null || true
  pkill -f "HypeProof Studio Dev.app/Contents/" 2>/dev/null || true
  if [[ -d "$WORKTREE_DIR" ]]; then
    echo "Removing worktree $WORKTREE_DIR..."
    git -C "$REPO" worktree remove "$WORKTREE_DIR" --force 2>/dev/null || true
  fi
  echo "Done."
}
trap cleanup EXIT

# ── Step 1: worktree ──────────────────────────────────────────────────────────
echo ""
echo "=== [1/6] Worktree ==="
if [[ -d "$WORKTREE_DIR" ]]; then
  echo "Reusing existing worktree at $WORKTREE_DIR"
  git -C "$REPO" fetch origin "$BRANCH" --quiet
  git -C "$WORKTREE_DIR" checkout --detach "origin/$BRANCH" 2>&1
  echo "Updated to: $(git -C "$WORKTREE_DIR" rev-parse HEAD)"
else
  T1=$(ms)
  git -C "$REPO" fetch origin "$BRANCH" --quiet
  git -C "$REPO" worktree add "$WORKTREE_DIR" "origin/$BRANCH" 2>&1
  T1_END=$(ms)
  echo "Worktree ready in $(( T1_END - T1 ))ms"
  echo "Building: $(git -C "$WORKTREE_DIR" rev-parse HEAD)"
fi

# ── Step 2: extension deps ────────────────────────────────────────────────────
echo ""
echo "=== [2/6] npm ci ==="
T2=$(ms)
(cd "$WORKTREE_DIR/extensions/hypeproof-chat" && npm ci --prefer-offline --silent 2>&1)
(cd "$WORKTREE_DIR/extensions/hypeproof-chat/webview-ui" && npm ci --prefer-offline --silent 2>&1)
T2_END=$(ms)
echo "npm ci done in $(( T2_END - T2 ))ms"

# ── Step 3: local server ──────────────────────────────────────────────────────
echo ""
echo "=== [3/6] Local server (port $WRANGLER_PORT) ==="

# .dev.vars: always generate a fresh local-only signing secret
WORKER_DIR="$WORKTREE_DIR/worker"
DEV_VARS="$WORKER_DIR/.dev.vars"

# Generate a random 32-char hex secret (never production value)
LOCAL_SECRET="dev-local-$(LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 20)"

cat > "$DEV_VARS" << EOF
HPS_SIGNING_SECRET="$LOCAL_SECRET"
ENVIRONMENT="dev"
LLM_PROVIDER="anthropic"
EOF
echo "Created $DEV_VARS with local random signing secret."

# Worker deps
(cd "$WORKER_DIR" && npm ci --prefer-offline --silent 2>&1)

# Init D1 (idempotent: schema uses CREATE TABLE IF NOT EXISTS)
echo "Initialising local D1..."
(cd "$WORKER_DIR" && npx wrangler d1 execute hypeproof-studio --local --file schema.sql 2>&1 | grep -v "^$\|Reading\|Executing" || true)

# Apply migrations
if ls "$WORKER_DIR"/migrations/*.sql >/dev/null 2>&1; then
  for mig in "$WORKER_DIR"/migrations/*.sql; do
    npx --prefix "$WORKER_DIR" wrangler d1 execute hypeproof-studio --local --file "$mig" 2>&1 | grep -v "^$\|Reading\|Executing" || true
  done
fi

T3=$(ms)
(cd "$WORKER_DIR" && npx wrangler dev --local --port "$WRANGLER_PORT" 2>&1 &)
SERVER_PID=$!
echo "wrangler dev PID: $SERVER_PID"

# Wait for ready
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$WRANGLER_PORT/healthz" >/dev/null 2>&1 || \
     curl -sf "http://127.0.0.1:$WRANGLER_PORT/" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
T3_END=$(ms)
echo "Server ready in $(( T3_END - T3 ))ms"

# ── Step 4: instructor token ──────────────────────────────────────────────────
echo ""
echo "=== [4/6] Instructor token ==="

# Auto-detect first available profile and its cohort
PROFILE_ID="$(grep -h "^  id:" "$WORKTREE_DIR"/worker/src/profiles/*.ts 2>/dev/null | head -1 | sed "s/.*id: ['\"]//;s/['\"].*//" | tr -d ' ')"
COHORT_ID="$(grep -h "cohort_id:" "$WORKTREE_DIR"/worker/src/profiles/*.ts 2>/dev/null | head -1 | sed "s/.*cohort_id: ['\"]//;s/['\"].*//" | tr -d ' ')"

if [[ -z "$PROFILE_ID" || -z "$COHORT_ID" ]]; then
  echo "WARNING: Could not auto-detect profile/cohort. Use the token issued below manually." >&2
  PROFILE_ID="unknown-profile"
  COHORT_ID="unknown-cohort"
fi
echo "Profile: $PROFILE_ID  Cohort: $COHORT_ID"

TOKEN_JSON="$(HPS_SIGNING_SECRET="$LOCAL_SECRET" \
  node --experimental-strip-types \
  "$WORKTREE_DIR/worker/scripts/issue-issuer-token.ts" \
  --instructor "jy-review-$$" \
  --cohorts "$COHORT_ID" \
  --profiles "$PROFILE_ID" \
  --max-hours 4 --days 1 2>&1)"

TOKEN="$(echo "$TOKEN_JSON" | python3 -c "import sys,re; m=re.search(r'\"token\":\s*\"([^\"]+)\"', sys.stdin.read()); print(m.group(1) if m else '')" 2>/dev/null)"
if [[ -z "$TOKEN" ]]; then
  echo "WARNING: Token extraction failed. Raw output:" >&2
  echo "$TOKEN_JSON" >&2
else
  echo "Token issued."
  # Copy to clipboard if pbcopy available
  if command -v pbcopy >/dev/null 2>&1; then
    echo "$TOKEN" | pbcopy
    echo "Token copied to clipboard."
  else
    echo ""
    echo "── TOKEN (paste into the app) ──────────────────────"
    echo "$TOKEN"
    echo "────────────────────────────────────────────────────"
  fi
fi

# ── Step 5: Dev app ───────────────────────────────────────────────────────────
echo ""
echo "=== [5/6] Dev app ==="
T5=$(ms)
python3 "$WORKTREE_DIR/scripts/studio-dev.py" run \
  --provider "$PROVIDER" \
  --service local 2>&1
T5_END=$(ms)
echo "studio-dev.py run done in $(( T5_END - T5 ))ms"

# ── Step 6: instructions ──────────────────────────────────────────────────────
echo ""
echo "=== [6/6] Ready ==="
echo "HypeProof Studio Dev is running."
echo ""
echo "In the app:"
echo "  1. Click the HypeProof chat icon in the sidebar"
echo "  2. Select '수업 참여'"
if [[ -n "${TOKEN:-}" ]] && command -v pbcopy >/dev/null 2>&1; then
  echo "  3. Paste the token (already in clipboard)"
else
  echo "  3. Paste the token shown above"
fi
echo ""
echo "When done reviewing, press Ctrl+C to clean up."

# Wait forever (cleanup runs on exit)
wait

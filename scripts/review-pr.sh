#!/usr/bin/env bash
# JY dev review: one command from PR number to Dev app window.
# Usage: bash scripts/review-pr.sh <PR-number-or-branch> [--provider claude|codex|service] [--vault <path>]
# Wraps studio-dev.py; never touches production values.
# --vault <path>  explicit path to the curriculum_wiki vault for Chalk knowledge import.
#                 Falls back to CHALK_VAULT_PATH env var, then auto-detects sibling repo paths.
set -Eeuo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PROVIDER="service"
INPUT="${1:-}"
WRANGLER_PORT=8787
VAULT_PATH_ARG=""
KB_SQL=""

if [[ -z "$INPUT" ]]; then
  echo "Usage: bash scripts/review-pr.sh <PR-number-or-branch> [--provider claude|codex|service] [--vault <path>]" >&2
  exit 1
fi
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider) PROVIDER="$2"; shift 2 ;;
    --vault) VAULT_PATH_ARG="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Pre-flight checks (before any network calls) ──────────────────────────────
if lsof -iTCP:"$WRANGLER_PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  HOLDER="$(lsof -iTCP:$WRANGLER_PORT -sTCP:LISTEN -Fp 2>/dev/null | grep -m1 '^p' | sed 's/^p//')"
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
FETCH_REF=""      # what to git fetch (branch name or "main" for merged commit)
CHECKOUT_REF=""   # what to checkout (origin/<branch> or bare commit sha)
if [[ "$INPUT" =~ ^[0-9]+$ ]]; then
  PR_JSON="$(gh pr view "$INPUT" --repo jayleekr/hypeproof-studio --json state,headRefName,mergeCommit)"
  PR_STATE="$(python3 -c "import sys,json; print(json.loads(sys.stdin.read())['state'])" <<< "$PR_JSON")"
  if [[ "$PR_STATE" == "MERGED" ]]; then
    BRANCH="$(python3 -c "import sys,json; print(json.loads(sys.stdin.read())['mergeCommit']['oid'])" <<< "$PR_JSON")"
    FETCH_REF="main"
    CHECKOUT_REF="$BRANCH"
    echo "PR #$INPUT → MERGED, commit: $BRANCH"
  elif [[ "$PR_STATE" == "OPEN" ]]; then
    BRANCH="$(python3 -c "import sys,json; print(json.loads(sys.stdin.read())['headRefName'])" <<< "$PR_JSON")"
    FETCH_REF="$BRANCH"
    CHECKOUT_REF="origin/$BRANCH"
    echo "PR #$INPUT → branch: $BRANCH"
  else
    echo "ERROR: PR #$INPUT is CLOSED (unmerged). Cannot review a closed PR." >&2
    exit 1
  fi
else
  BRANCH="$INPUT"
  FETCH_REF="$BRANCH"
  CHECKOUT_REF="origin/$BRANCH"
fi

SAFE_BRANCH="${BRANCH//\//-}"
TMP_BASE="${TMPDIR:-/tmp}"; TMP_BASE="${TMP_BASE%/}"
WORKTREE_DIR="$TMP_BASE/studio-review-${SAFE_BRANCH}"

# Persist stdout+stderr to a log file outside the worktree (survives cleanup).
# Token values are never echoed to stdout — only "Token issued." / clipboard path.
LOG_FILE="${TMP_BASE}/review-pr-${SAFE_BRANCH}-$(date +%Y%m%d-%H%M%S).log"
echo "Log: $LOG_FILE"
exec > >(tee -a "$LOG_FILE") 2>&1

# macOS BSD date does not support %N; use python3 for millisecond timestamps.
ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

_CLEANUP_DONE=0
cleanup() {
  [[ $_CLEANUP_DONE -eq 1 ]] && return; _CLEANUP_DONE=1
  echo ""
  echo "=== Cleanup ==="
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Stopping wrangler dev (PID $SERVER_PID)..."
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  pkill -f "wrangler dev.*--port $WRANGLER_PORT" 2>/dev/null || true
  pkill -f "HypeProof Studio Dev.app/Contents/" 2>/dev/null || true
  [[ -n "${KB_SQL:-}" ]] && rm -f "$KB_SQL" 2>/dev/null || true
  [[ -n "${HPS_DEV_ISSUER_TOKEN_FILE:-}" ]] && rm -f "$HPS_DEV_ISSUER_TOKEN_FILE" 2>/dev/null || true
  if [[ -d "$WORKTREE_DIR" ]]; then
    echo "Removing worktree $WORKTREE_DIR..."
    git -C "$REPO" worktree remove "$WORKTREE_DIR" --force 2>/dev/null || true
  fi
  echo "Done."
}
trap cleanup EXIT INT TERM
trap 'echo "FAILED at line $LINENO: $BASH_COMMAND" >&2' ERR

# ── Step 1: worktree ──────────────────────────────────────────────────────────
echo ""
echo "=== [1/6] Worktree ==="
if [[ -d "$WORKTREE_DIR" ]]; then
  echo "Reusing existing worktree at $WORKTREE_DIR"
  git -C "$REPO" fetch origin "$FETCH_REF" --quiet
  git -C "$WORKTREE_DIR" checkout --detach "$CHECKOUT_REF" 2>&1
  echo "Updated to: $(git -C "$WORKTREE_DIR" rev-parse HEAD)"
else
  T1=$(ms)
  git -C "$REPO" fetch origin "$FETCH_REF" --quiet
  git -C "$REPO" worktree add "$WORKTREE_DIR" "$CHECKOUT_REF" 2>&1
  T1_END=$(ms)
  echo "Worktree ready in $(( T1_END - T1 ))ms"
  echo "Building: $(git -C "$WORKTREE_DIR" rev-parse HEAD)"
fi

# ── Step 1.5: clear previous conversation ────────────────────────────────────
# Clears persisted chat history (chatPanelProvider.ts workspaceState key hypeproofChat.history*)
# from the Dev state folder so each review starts with a clean slate.
# The state path mirrors studio-dev.py:19+222 (resolve().parents[1] + sha256[:12]).
echo ""
echo "=== [1.5/6] Clear previous conversation ==="
STATE_HASH="$(python3 - "$WORKTREE_DIR/scripts/studio-dev.py" <<'PY'
import sys, hashlib, pathlib
repo = pathlib.Path(sys.argv[1]).resolve().parents[1]
print(hashlib.sha256(str(repo).encode()).hexdigest()[:12])
PY
)"
STATE_DIR="$HOME/Library/Application Support/HypeProof Studio Development/$STATE_HASH"
TOTAL_DELETED=0
if [[ -d "$STATE_DIR/user-data/User/workspaceStorage" ]]; then
  while IFS= read -r -d '' db; do
    COUNT_BEFORE=0
    COUNT_BEFORE="$(sqlite3 "$db" "SELECT COUNT(*) FROM ItemTable WHERE key LIKE 'hypeproofChat.history%';" 2>/dev/null || echo 0)"
    if [[ "$COUNT_BEFORE" -gt 0 ]]; then
      sqlite3 "$db" "DELETE FROM ItemTable WHERE key LIKE 'hypeproofChat.history%';" 2>/dev/null || true
      TOTAL_DELETED=$((TOTAL_DELETED + COUNT_BEFORE))
    fi
  done < <(find "$STATE_DIR/user-data/User/workspaceStorage" -name "state.vscdb" -print0 2>/dev/null)
fi
[[ $TOTAL_DELETED -gt 0 ]] && echo "이전 대화 비움 (${TOTAL_DELETED}행)" || echo "지울 대화 없음"

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

# Generate a random 20-char hex secret (never production value).
# openssl rand has no pipe: avoids SIGPIPE from tr|head under set -o pipefail.
LOCAL_SECRET="dev-local-$(openssl rand -hex 10)"

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

# Migrations are NOT applied here: schema.sql is the cumulative snapshot and
# AT-33 asserts schema.sql == applying all migrations in order (same DDL).
# Running migrations on a fresh local DB would produce duplicate-object errors.

# ── Step 3.5: Chalk knowledge import ─────────────────────────────────────────
IMPORT_SCRIPT="$WORKTREE_DIR/scripts/chalk-knowledge-import/index.ts"
if [[ -f "$IMPORT_SCRIPT" ]]; then
  echo ""
  echo "=== [3.5] Chalk knowledge import ==="

  # Resolve vault path: arg > env > auto-detect
  VAULT=""
  if [[ -n "$VAULT_PATH_ARG" ]]; then
    VAULT="$VAULT_PATH_ARG"
  elif [[ -n "${CHALK_VAULT_PATH:-}" ]]; then
    VAULT="$CHALK_VAULT_PATH"
  else
    # Auto-detect: sibling repo candidates
    REPO_PARENT="$(dirname "$REPO")"
    for candidate in \
      "$REPO_PARENT/hypeproof_kids_edu/kids_edu_vault/curriculum_wiki" \
      "$HOME/Git/hypeproof_kids_edu/kids_edu_vault/curriculum_wiki" \
      "$HOME/Git/HypeProof/hypeproof_kids_edu/kids_edu_vault/curriculum_wiki"; do
      if [[ -f "$candidate/rules/curriculum-schema.md" ]]; then
        VAULT="$candidate"
        break
      fi
    done
  fi

  if [[ -z "$VAULT" ]] || [[ ! -f "$VAULT/rules/curriculum-schema.md" ]]; then
    echo "WARNING: 볼트를 찾지 못했습니다 — 모형 추천·brief 는 409로 응답합니다." >&2
    echo "  (--vault <path> 또는 CHALK_VAULT_PATH 로 경로를 지정하세요)" >&2
  else
    KB_SQL="$(mktemp /tmp/chalk-kb-XXXXXX.sql)"
    echo "볼트: $VAULT"
    if node --experimental-strip-types "$IMPORT_SCRIPT" \
        --vault-path "$VAULT" \
        --version 1 \
        --note "review-pr auto-import" \
        --created-by "review-pr.sh" \
        --out "$KB_SQL" 2>&1; then
      # Extract vault commit and doc count from the SQL comment header
      VAULT_COMMIT="$(grep -m1 'source_commit:' "$KB_SQL" | sed 's/.*source_commit: *//' | tr -d ' ')"
      DOC_COUNT="$(grep -m1 'doc_count:' "$KB_SQL" | sed 's/.*doc_count: *//' | tr -d ' ')"
      echo "적재 중... (commit: ${VAULT_COMMIT:-unknown}, docs: ${DOC_COUNT:-?})"
      LOAD_RC=0
      LOAD_OUT="$(cd "$WORKER_DIR" && npx wrangler d1 execute hypeproof-studio --local --file "$KB_SQL" 2>&1)" || LOAD_RC=$?
      echo "$LOAD_OUT" | grep -v "^$\|Reading\|Executing" || true
      if [[ $LOAD_RC -ne 0 ]]; then
        echo "WARNING: D1 적재 실패 (wrangler exit $LOAD_RC). 모형 추천·brief는 409로 응답합니다." >&2
      else
        COUNT_RC=0
        COUNT_OUT="$(cd "$WORKER_DIR" && npx wrangler d1 execute hypeproof-studio --local \
          --command "SELECT COUNT(*) FROM chalk_knowledge_docs WHERE version=1" \
          --json 2>/dev/null)" || COUNT_RC=$?
        if [[ $COUNT_RC -ne 0 ]]; then
          LOADED_COUNT="?"
        else
          LOADED_COUNT="$(python3 -c "
import sys, json
try:
    rows = json.loads(sys.stdin.read())
    print(rows[0]['results'][0].get('COUNT(*)', '?'))
except Exception:
    print('?')
" <<< "$COUNT_OUT")"
        fi
        if [[ -n "${DOC_COUNT:-}" ]] && [[ "${LOADED_COUNT:-?}" == "$DOC_COUNT" ]]; then
          echo "지식 적재 완료 — vault commit: ${VAULT_COMMIT:-unknown}, docs: ${DOC_COUNT}"
        else
          echo "WARNING: 적재된 문서 수 불일치 — 기대 ${DOC_COUNT:-?}, 실제 ${LOADED_COUNT:-?}. 추천·brief가 409일 수 있습니다." >&2
        fi
      fi
      rm -f "$KB_SQL"; KB_SQL=""
    else
      echo "WARNING: 지식 가져오기 실패 (어휘 검사 오류 가능). 계속 진행합니다." >&2
      rm -f "$KB_SQL"; KB_SQL=""
    fi
  fi
fi

T3=$(ms)
(cd "$WORKER_DIR" && npx wrangler dev --local --port "$WRANGLER_PORT" 2>&1) &
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
PROFILE_ID="$(grep -h -m1 "^  id:" "$WORKTREE_DIR"/worker/src/profiles/*.ts 2>/dev/null | sed "s/.*id: ['\"]//;s/['\"].*//" | tr -d ' ')"
COHORT_ID="$(grep -h -m1 "cohort_id:" "$WORKTREE_DIR"/worker/src/profiles/*.ts 2>/dev/null | sed "s/.*cohort_id: ['\"]//;s/['\"].*//" | tr -d ' ')"

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
  echo "WARNING: Token extraction failed. Redacted output:" >&2
  echo "$TOKEN_JSON" | sed -E 's/("token":[[:space:]]*")[^"]+/\1***/' >&2
else
  echo "Token issued."
  # Write token to file for HPS_DEV_ISSUER_TOKEN_FILE auto-seed in Dev app.
  # Cleanup trap removes the file. Never print the token value in logs.
  ISSUER_TOKEN_FILE="$WORKTREE_DIR/issuer-token.txt"
  (umask 077; printf '%s' "$TOKEN" > "$ISSUER_TOKEN_FILE")
  export HPS_DEV_ISSUER_TOKEN_FILE="$ISSUER_TOKEN_FILE"
  echo "Instructor token written to worktree (auto-injected into Dev app)."
fi

# ── Step 4.5: authoring draft ─────────────────────────────────────────────────
# Creates a minimal authoring draft so chalk_set_inputs (which requires an existing draft)
# does not return 404 during review. Writes only to 127.0.0.1 (local D1).
echo ""
echo "=== [4.5/6] Authoring draft ==="
DRAFT_COURSE=""
if [[ "$PROFILE_ID" == "unknown-profile" || "$COHORT_ID" == "unknown-cohort" ]]; then
  echo "WARNING: 초안 없음 — set_inputs 404 예상 (profile/cohort 미확인)" >&2
elif [[ -z "${TOKEN:-}" ]]; then
  echo "WARNING: 초안 없음 — set_inputs 404 예상 (토큰 없음)" >&2
else
  DRAFT_COURSE="review-$(python3 -c 'import time; print(int(time.time()))')"
  DRAFT_REQUEST_ID="$(openssl rand -hex 16)"
  DRAFT_BODY_FILE="$(mktemp "$WORKTREE_DIR/.draft-body-XXXXXX.json")"
  chmod 600 "$DRAFT_BODY_FILE"
  DRAFT_CONTENT='{"schema":"hps-session-design/1","title":"review draft","audience":"","duration_minutes":60,"objective":"","prerequisites":"","starter":"","steps":[]}'
  printf '{"expected_revision":0,"request_id":"%s","profile_id":"%s","content":%s}' \
    "$DRAFT_REQUEST_ID" "$PROFILE_ID" "$DRAFT_CONTENT" > "$DRAFT_BODY_FILE"
  DRAFT_RC=0
  printf 'Authorization: Bearer %s\n' "$TOKEN" | \
    curl -sf -X PUT -H @- -H 'Content-Type: application/json' \
    --data-binary @"$DRAFT_BODY_FILE" \
    "http://127.0.0.1:${WRANGLER_PORT}/admin/cohorts/${COHORT_ID}/authoring/${DRAFT_COURSE}" \
    >/dev/null 2>&1 || DRAFT_RC=$?
  rm -f "$DRAFT_BODY_FILE"
  if [[ $DRAFT_RC -ne 0 ]]; then
    echo "WARNING: 초안 없음 — set_inputs 404 예상" >&2
    DRAFT_COURSE=""
  else
    echo "Draft created: cohort=${COHORT_ID} course=${DRAFT_COURSE}"
  fi
fi

# ── Step 5: Dev app ───────────────────────────────────────────────────────────
echo ""
echo "=== [5/6] Dev app ==="

# Note: instructor (issuer) token is seeded only via HPS_DEV_ISSUER_TOKEN_FILE above.
# Never write it to local-participant-token.txt (TOKEN_KEY student slot).

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
echo "  2. 강사 모드 띠(Instructor 배너)가 표시되는지 확인 — 토큰 붙여 넣기 불필요"
if [[ -n "${DRAFT_COURSE:-}" ]]; then
  echo "  3. chalk_set_inputs 호출 시 로그에 찍힌 강의 ID(${DRAFT_COURSE})를 course 인자로 사용"
fi
echo ""
echo "When done reviewing, press Ctrl+C to clean up."

# Wait for the wrangler dev background job (cleanup runs on exit/INT/TERM).
# || true: prevents a non-zero exit from wrangler from triggering the ERR trap
# here — the trap was already sent before cleanup; this is normal shutdown.
wait "$SERVER_PID" 2>/dev/null || true

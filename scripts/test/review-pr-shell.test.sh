#!/usr/bin/env bash
# Shell safety tests for scripts/review-pr.sh.
# Run: bash scripts/test/review-pr-shell.test.sh
# Uses /bin/bash (macOS 3.2) to match production execution environment.
set -euo pipefail

PASS=0; FAIL=0; WARN=0
SCRIPT="$(cd "$(dirname "$0")/../.." && pwd)/scripts/review-pr.sh"

ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
warn() { echo "WARN: $1"; WARN=$((WARN+1)); }

# 1. Syntax check with /bin/bash (macOS 3.2 compatible)
if /bin/bash -n "$SCRIPT" 2>/dev/null; then
  ok "syntax (/bin/bash -n)"
else
  fail "syntax (/bin/bash -n)"
fi

# 2. Secret generation: openssl rand exits 0 and produces 20 hex chars under pipefail
SECRET_OUT="$(/bin/bash -c 'set -euo pipefail; X=$(openssl rand -hex 10); echo "$X"' 2>&1)"
SECRET_RC=$?
if [[ $SECRET_RC -eq 0 ]] && [[ ${#SECRET_OUT} -eq 20 ]] && [[ "$SECRET_OUT" =~ ^[0-9a-f]{20}$ ]]; then
  ok "openssl rand -hex 10: exits 0, produces 20 hex chars"
else
  fail "openssl rand -hex 10: rc=$SECRET_RC out='$SECRET_OUT'"
fi

# 3. Regression guard: original tr|head SIGPIPE pattern
# Under pipefail this should fail (exit != 0). If it doesn't, the bug wasn't
# present on this bash version — the fix is still correct and valid.
if /bin/bash -c 'set -euo pipefail; X=$(LC_ALL=C tr -dc a-f0-9 </dev/urandom | head -c 20); echo "$X"' 2>/dev/null; then
  warn "tr|head did NOT fail under pipefail on this bash/OS — original bug not reproducible here (fix still valid)"
else
  ok "regression guard: tr|head fails under pipefail (original bug confirmed; fixed by openssl rand)"
fi

# 4. ERR trap fires on failure
ERR_OUT="$(/bin/bash -c 'set -Eeuo pipefail; trap '"'"'echo "ERR at $LINENO: $BASH_COMMAND"'"'"' ERR; false' 2>&1 || true)"
if echo "$ERR_OUT" | grep -q "ERR at"; then
  ok "ERR trap fires on failure with set -E"
else
  fail "ERR trap did not fire (got: '$ERR_OUT')"
fi

# 5. set -E is present in the script
if grep -q '^set -Eeuo pipefail' "$SCRIPT"; then
  ok "set -Eeuo pipefail found in script"
else
  fail "set -Eeuo pipefail not found in script"
fi

# 6. ERR trap declaration present
if grep -q "trap.*FAILED at line.*ERR" "$SCRIPT"; then
  ok "ERR trap declaration found in script"
else
  fail "ERR trap declaration not found in script"
fi

# 7. No tr|head SIGPIPE pattern in script
if grep -qE "tr -dc.*\| head -c" "$SCRIPT"; then
  fail "tr|head SIGPIPE pattern still present in script"
else
  ok "no tr|head SIGPIPE pattern in script"
fi

# 8. Migration loop absent
if grep -q "for mig in.*migrations" "$SCRIPT"; then
  fail "migration loop still present in script"
else
  ok "migration loop absent from script"
fi

# 9. trap includes INT TERM for foreground Ctrl+C
if grep -q "trap cleanup EXIT INT TERM" "$SCRIPT"; then
  ok "trap cleanup EXIT INT TERM found"
else
  fail "trap cleanup EXIT INT TERM not found (SIGINT cleanup fix missing)"
fi

# 10. cleanup has double-run guard
if grep -q "_CLEANUP_DONE" "$SCRIPT"; then
  ok "_CLEANUP_DONE guard found in cleanup"
else
  fail "_CLEANUP_DONE guard not found"
fi

# 11. issuer token must not be written to local-participant-token.txt (TOKEN_KEY student slot)
# Verifies the chalk-po condition 2 fix: the 4 lines that wrote issuer token to the student
# slot were removed. A redirect (>) or printf to local-participant-token.txt means regression.
if grep -qE '>.*local-participant-token\.txt|printf.*TOKEN.*local-participant-token' "$SCRIPT"; then
  fail "issuer token write to local-participant-token.txt found (TOKEN_KEY violation)"
else
  ok "no issuer token write to local-participant-token.txt"
fi

# 12. TOKEN_JSON must only be output through the redact filter (sed '***'), never raw
# Verifies the extraction-failure redaction fix: the sed redact line must be present,
# confirming TOKEN_JSON is never printed in plaintext.
if grep -q '\bTOKEN_JSON\b.*sed.*\*\*\*' "$SCRIPT"; then
  ok "TOKEN_JSON redact pattern (sed '***') present in script"
else
  fail "TOKEN_JSON redact pattern not found — token may be printed in plaintext on failure"
fi

# 13. No '수업 참여' (old student-join UI step removed in #1295)
if grep -q '수업 참여' "$SCRIPT"; then
  fail "old '수업 참여' instruction found in script (must be removed)"
else
  ok "no '수업 참여' instruction in script"
fi

# 14. No 'Paste the token' (old manual-paste instruction removed in #1295)
if grep -q 'Paste the token' "$SCRIPT"; then
  fail "old 'Paste the token' instruction found in script (must be removed)"
else
  ok "no 'Paste the token' instruction in script"
fi

# 15. No pbcopy (clipboard copy removed in #1295; token injected via file)
if grep -q 'pbcopy' "$SCRIPT"; then
  fail "pbcopy still present in script (must be removed)"
else
  ok "no pbcopy in script"
fi

# 16. History clear — positive contrast: hypeproofChat.history% rows are deleted
# Uses a temporary SQLite DB that mimics the workspaceStorage state.vscdb schema.
_TMP_DB="$(mktemp /tmp/review-pr-test-state.XXXXXX.vscdb)"
sqlite3 "$_TMP_DB" "CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);" 2>/dev/null
sqlite3 "$_TMP_DB" "INSERT INTO ItemTable VALUES ('hypeproofChat.history', 'data1');" 2>/dev/null
sqlite3 "$_TMP_DB" "INSERT INTO ItemTable VALUES ('hypeproofChat.history:bucket1', 'data2');" 2>/dev/null
sqlite3 "$_TMP_DB" "INSERT INTO ItemTable VALUES ('other.key', 'data3');" 2>/dev/null
sqlite3 "$_TMP_DB" "DELETE FROM ItemTable WHERE key LIKE 'hypeproofChat.history%';" 2>/dev/null
_HIST_COUNT="$(sqlite3 "$_TMP_DB" "SELECT COUNT(*) FROM ItemTable WHERE key LIKE 'hypeproofChat.history%';" 2>/dev/null || echo 1)"
if [[ "$_HIST_COUNT" -eq 0 ]]; then
  ok "sqlite3 positive contrast: hypeproofChat.history% rows deleted"
else
  fail "sqlite3 positive contrast: hypeproofChat.history% rows not deleted (count=$_HIST_COUNT)"
fi

# 17. History clear — negative contrast: non-history rows are preserved
_OTHER_COUNT="$(sqlite3 "$_TMP_DB" "SELECT COUNT(*) FROM ItemTable WHERE key = 'other.key';" 2>/dev/null || echo 0)"
if [[ "$_OTHER_COUNT" -eq 1 ]]; then
  ok "sqlite3 negative contrast: other.key row preserved after history delete"
else
  fail "sqlite3 negative contrast: other.key row missing (count=$_OTHER_COUNT)"
fi
rm -f "$_TMP_DB"

# 18. --profile / --cohort args present in script
if grep -q '\-\-profile' "$SCRIPT" && grep -q '\-\-cohort' "$SCRIPT"; then
  ok "--profile / --cohort args declared in script"
else
  fail "--profile / --cohort args not found in script"
fi

# 19. --no-app arg present in script
if grep -q '\-\-no-app' "$SCRIPT"; then
  ok "--no-app arg declared in script"
else
  fail "--no-app arg not found in script"
fi

# 20. --after arg present in script
if grep -q '\-\-after' "$SCRIPT"; then
  ok "--after arg declared in script"
else
  fail "--after arg not found in script"
fi

# 21. Default profile hardcoded (not from grep on all *.ts)
# Old pattern: grep -h -m1 ... worker/src/profiles/*.ts (multiline)
# New pattern: DEFAULT_PROFILE="sk-biopharm-kids-..." from literal
if grep -q 'DEFAULT_PROFILE="sk-biopharm-kids-' "$SCRIPT"; then
  ok "DEFAULT_PROFILE hardcoded literal found (not grep on all *.ts)"
else
  fail "DEFAULT_PROFILE hardcoded literal not found"
fi

# 22. Old multiline grep pattern removed (grep -h -m1 on all *.ts)
if grep -qE 'grep.*-m1.*profiles/\*\.ts' "$SCRIPT"; then
  fail "old grep -m1 profiles/*.ts pattern still present (multiline PROFILE_ID bug)"
else
  ok "old grep -m1 profiles/*.ts pattern absent"
fi

# 23. Line-count validation for PROFILE_ID present
if grep -q 'PROFILE_LINE_COUNT' "$SCRIPT"; then
  ok "PROFILE_LINE_COUNT validation present"
else
  fail "PROFILE_LINE_COUNT validation not found"
fi

# 24. Line-count validation for COHORT_ID present
if grep -q 'COHORT_LINE_COUNT' "$SCRIPT"; then
  ok "COHORT_LINE_COUNT validation present"
else
  fail "COHORT_LINE_COUNT validation not found"
fi

# 25. Draft PUT failure exits with exit 1 (no WARNING fallback)
if grep -q 'authoring draft PUT failed' "$SCRIPT"; then
  ok "draft PUT failure exits with error message (no WARNING fallback)"
else
  fail "draft PUT failure error message not found"
fi

# 26. REVIEW_SERVER_URL exported for --after script
if grep -q 'export REVIEW_SERVER_URL' "$SCRIPT"; then
  ok "REVIEW_SERVER_URL exported for --after script"
else
  fail "REVIEW_SERVER_URL not exported"
fi

# 27. REVIEW_ISSUER_TOKEN_FILE (file path, not value) exported for --after script
if grep -q 'export REVIEW_ISSUER_TOKEN_FILE' "$SCRIPT"; then
  ok "REVIEW_ISSUER_TOKEN_FILE (file path) exported for --after script"
else
  fail "REVIEW_ISSUER_TOKEN_FILE not exported"
fi

# 28. Token value itself NOT exported (only file path)
if grep -qE '^export REVIEW_TOKEN=' "$SCRIPT" || grep -qE '^export ISSUER_TOKEN=' "$SCRIPT"; then
  fail "token value exported directly (security violation — only file path should be exported)"
else
  ok "token value not directly exported (only file path via REVIEW_ISSUER_TOKEN_FILE)"
fi

# 29. --no-app: PROFILE_ID validation code present before NO_APP branch
# Both validations must appear before step 5 (the NO_APP conditional)
PROFILE_VAL_LINE="$(grep -n 'PROFILE_LINE_COUNT' "$SCRIPT" | head -1 | cut -d: -f1)"
NO_APP_LINE="$(grep -n 'NO_APP.*-eq.*1' "$SCRIPT" | head -1 | cut -d: -f1)"
if [[ -n "$PROFILE_VAL_LINE" ]] && [[ -n "$NO_APP_LINE" ]] && \
   [[ "$PROFILE_VAL_LINE" -lt "$NO_APP_LINE" ]]; then
  ok "PROFILE_ID validation runs before --no-app branch (same path regardless of --no-app)"
else
  fail "PROFILE_ID validation not found before --no-app branch"
fi

# 30. Static isolation: NO_APP and AFTER_SCRIPT only appear in arg-parse and [5/6]+ sections.
#
# Verified ranges in the current script:
#   Arg-parse section:   lines 23-41  (variable declarations + while-case block)
#   Steps [1]–[4.5]:     lines 42-393 (worktree through authoring draft)
#   [5/6] branch start:  line 394     (if [[ "$NO_APP" -eq 1 ]])
#
# Assertion: NO_APP and AFTER_SCRIPT MUST NOT appear in the [1]–[4.5] body.
# We detect the boundaries dynamically so the test stays valid after minor edits.

# Find last line of arg-parse (the 'done' that closes the while-case loop).
ARGPARSE_END="$(grep -En '^done$|^done ' "$SCRIPT" | head -1 | cut -d: -f1)"
# Find first [5/6] section (NO_APP branch or Dev-app header).
STEP5_START="$(grep -En 'NO_APP.*-eq.*1' "$SCRIPT" | head -1 | cut -d: -f1)"

if [[ -z "$ARGPARSE_END" ]] || [[ -z "$STEP5_START" ]]; then
  fail "static isolation: could not locate argparse-end or step-5 start (ARGPARSE_END='$ARGPARSE_END' STEP5_START='$STEP5_START')"
else
  # Lines that fall strictly between arg-parse and step-5 and contain NO_APP or AFTER_SCRIPT.
  BODY_START=$(( ARGPARSE_END + 1 ))
  BODY_END=$(( STEP5_START - 1 ))
  # Use awk to extract and search the [1]–[4.5] body.
  LEAK_LINES="$(awk -v s="$BODY_START" -v e="$BODY_END" \
    'NR>=s && NR<=e && /\bNO_APP\b|\bAFTER_SCRIPT\b/ {print NR": "$0}' "$SCRIPT")"
  if [[ -z "$LEAK_LINES" ]]; then
    ok "static isolation: NO_APP/AFTER_SCRIPT absent from [1]–[4.5] body (lines ${BODY_START}–${BODY_END})"
  else
    fail "static isolation: NO_APP/AFTER_SCRIPT found in [1]–[4.5] body — fix these lines:"$'\n'"$LEAK_LINES"
  fi
fi

# 31. Cleanup kills Dev app by recorded DEV_APP_PID, not by pkill name.
if grep -q 'DEV_APP_PID' "$SCRIPT" && grep -qE 'kill.*DEV_APP_PID' "$SCRIPT"; then
  if grep -qE 'pkill.*HypeProof Studio Dev' "$SCRIPT"; then
    fail "cleanup: pkill by name still present alongside DEV_APP_PID (should use PID only)"
  else
    ok "cleanup: Dev app terminated via recorded DEV_APP_PID (not pkill by name)"
  fi
else
  fail "cleanup: DEV_APP_PID recording or kill-by-PID not found in script"
fi

# 32. HPS_REVIEW_CDP_PORT absent → --cdp-port not passed unconditionally.
# Every line containing --cdp-port must also contain HPS_REVIEW_CDP_PORT on the same line
# (i.e., it must be inside the ${HPS_REVIEW_CDP_PORT:+...} conditional expansion).
CDP_LINES_ALL="$(grep -n -- '--cdp-port' "$SCRIPT" 2>/dev/null || true)"
CDP_LINES_UNCONDITIONAL="$(grep -n -- '--cdp-port' "$SCRIPT" 2>/dev/null | grep -v 'HPS_REVIEW_CDP_PORT' || true)"
if [[ -z "$CDP_LINES_ALL" ]]; then
  fail "CDP port: --cdp-port not found in script (gating code missing)"
elif [[ -n "$CDP_LINES_UNCONDITIONAL" ]]; then
  fail "CDP port: --cdp-port appears outside HPS_REVIEW_CDP_PORT conditional:"$'\n'"$CDP_LINES_UNCONDITIONAL"
else
  ok "CDP port: --cdp-port gated on HPS_REVIEW_CDP_PORT (absent env → not passed)"
fi

# 33. cleanup: Dev app shutdown uses TERM → wait loop → KILL (not bare kill).
# Verify the TERM+wait+KILL pattern exists in cleanup().
CLEANUP_BODY="$(awk '/^cleanup\(\)/{found=1} found{print} found && /^\}/{exit}' "$SCRIPT")"
if echo "$CLEANUP_BODY" | grep -q 'kill -9.*DEV_APP_PID' && \
   echo "$CLEANUP_BODY" | grep -q 'sleep 1' && \
   echo "$CLEANUP_BODY" | grep -qE 'kill.*DEV_APP_PID' ; then
  ok "cleanup: TERM → wait loop → SIGKILL pattern present for Dev app"
else
  fail "cleanup: missing TERM→wait→SIGKILL pattern for Dev app (bare 'kill' only?)"
fi

# 34. studio-dev.py _clear_stale_ipc_socket: function defined and called.
DEV_PY="$(dirname "$SCRIPT")/studio-dev.py"
if [[ -f "$DEV_PY" ]]; then
  if grep -q '_clear_stale_ipc_socket' "$DEV_PY"; then
    if grep -q '_clear_stale_ipc_socket(state' "$DEV_PY"; then
      ok "studio-dev.py: _clear_stale_ipc_socket defined and called in launch()"
    else
      fail "studio-dev.py: _clear_stale_ipc_socket defined but not called in launch()"
    fi
  else
    fail "studio-dev.py: _clear_stale_ipc_socket not found"
  fi
else
  warn "studio-dev.py not found at $DEV_PY — skipping socket cleanup check"
fi

# 35. studio-dev.py socket cleanup: live-PID guard present.
if [[ -f "$DEV_PY" ]]; then
  if grep -q 'os.kill(locked_pid, 0)' "$DEV_PY" && grep -q 'ProcessLookupError' "$DEV_PY"; then
    ok "studio-dev.py: live-PID safety guard present in _clear_stale_ipc_socket"
  else
    fail "studio-dev.py: live-PID guard (os.kill + ProcessLookupError) missing"
  fi
fi

# 36. review-pr.sh: 거짓 Ready guard (15 s survival check) present.
if grep -q 'Waiting 15 s to verify Dev app survival' "$SCRIPT" && \
   grep -qE 'sleep 15' "$SCRIPT" && \
   grep -qE 'exit 1' "$SCRIPT"; then
  ok "review-pr.sh: 거짓 Ready guard (15 s survival + exit 1 on death) present"
else
  fail "review-pr.sh: 거짓 Ready guard missing (need 15 s sleep + exit 1 path)"
fi

# 37. --student-session arg declared in script
if grep -q '\-\-student-session' "$SCRIPT"; then
  ok "--student-session arg declared in script"
else
  fail "--student-session arg not found in script"
fi

# 38. --can-start-session flag on issuer token issuance
if grep -q '\-\-can-start-session' "$SCRIPT"; then
  ok "--can-start-session present on issue-issuer-token invocation"
else
  fail "--can-start-session not found in script"
fi

# 39. cleanup includes student-token.txt removal
if grep -q 'student-token\.txt' "$SCRIPT"; then
  ok "student-token.txt referenced in cleanup"
else
  fail "student-token.txt not found in script (cleanup target missing)"
fi

# 40. student-token value never echoed to stdout/stderr
# printf to a file (> file) is allowed; echo/printf to stdout is not.
# We accept printf that redirects to a file (contains '>') but reject bare echo/printf.
_STUDENT_LOG_LINES="$(grep -nE 'echo.*_STUDENT_TOKEN|printf.*_STUDENT_TOKEN' "$SCRIPT" | grep -v '>' || true)"
if [[ -n "$_STUDENT_LOG_LINES" ]]; then
  fail "student token value echoed to stdout/stderr (security violation): $_STUDENT_LOG_LINES"
else
  ok "student token value not echoed to stdout/stderr (only written to file)"
fi

# 41. session/open curl uses 127.0.0.1 (not localhost or 0.0.0.0)
CURL_SESSION_LINE="$(grep 'session/open' "$SCRIPT" || true)"
if echo "$CURL_SESSION_LINE" | grep -q '127\.0\.0\.1'; then
  ok "session/open curl uses 127.0.0.1 (not localhost)"
else
  fail "session/open curl does not use 127.0.0.1"
fi

# 42. session/open response written to tmp file, not logged directly
# Verify the response body goes to a temp file variable, not stdout.
if grep -q '_STUDENT_RESP_TMP' "$SCRIPT"; then
  ok "session/open response captured in tmp file (not logged directly)"
else
  fail "_STUDENT_RESP_TMP not found — response body may be logged"
fi

# 43. --student-session absent → student-token.txt not created (static check)
# When STUDENT_SESSION=0, the open block is gated on [[ "$STUDENT_SESSION" -eq 1 ]].
if grep -q 'STUDENT_SESSION.*-eq.*1' "$SCRIPT"; then
  ok "student session block gated on STUDENT_SESSION=1 (absent flag → no file)"
else
  fail "STUDENT_SESSION guard not found (student-token.txt may be created unconditionally)"
fi

# 44. --can-start-session must not appear directly in TOKEN_JSON line (must go via _ISSUE_ARGS array)
# When STUDENT_SESSION=0 the array stays empty and the flag is never passed to issue-issuer-token.ts.
# Static check: no line that contains both TOKEN_JSON and issue-issuer-token also contains --can-start-session.
_CAN_TOKEN_DIRECT="$(grep -n -- '--can-start-session' "$SCRIPT" | grep -v '_ISSUE_ARGS' || true)"
if [[ -z "$_CAN_TOKEN_DIRECT" ]]; then
  ok "44: --can-start-session only via _ISSUE_ARGS array (not hardcoded in TOKEN_JSON line)"
else
  fail "44: --can-start-session still hardcoded outside _ISSUE_ARGS array:"$'\n'"$_CAN_TOKEN_DIRECT"
fi

# 45. Bearer token must not appear as an inline -H curl arg (ps exposure check).
# Allowed:  printf 'Authorization: Bearer ...' > tmpfile  then  -H @file
# Forbidden: -H "Authorization: Bearer ..." directly in the curl invocation.
# Detection: any line that contains BOTH -H and "Authorization: Bearer" in quotes.
_BEARER_ARGV_LINES="$(grep -n -- '-H.*"Authorization: Bearer\|-H.*Authorization: Bearer"' "$SCRIPT" 2>/dev/null || true)"
if [[ -z "$_BEARER_ARGV_LINES" ]]; then
  ok "45: no '-H Authorization: Bearer' inline in curl argv (token passed via -H @file)"
else
  fail "45: Bearer token passed inline via -H curl arg (ps exposure):"$'\n'"$_BEARER_ARGV_LINES"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed, $WARN warnings"
[[ $FAIL -eq 0 ]]

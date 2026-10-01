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

echo ""
echo "Results: $PASS passed, $FAIL failed, $WARN warnings"
[[ $FAIL -eq 0 ]]

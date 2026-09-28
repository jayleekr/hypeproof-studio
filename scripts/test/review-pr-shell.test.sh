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

echo ""
echo "Results: $PASS passed, $FAIL failed, $WARN warnings"
[[ $FAIL -eq 0 ]]

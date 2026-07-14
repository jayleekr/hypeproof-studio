#!/usr/bin/env bash
# e2e-quiet.sh — run the FULL local e2e suite invisibly and only while Jay is away.
#
# Two layers of "don't interrupt Jay":
#   1. Quiet mode (HPS_QUIET=1, the fixture default) keeps the Electron window
#      off-screen + the app hidden even while it runs.
#   2. This screen-lock gate only *starts* the suite once the screen is locked,
#      and aborts (kills the app) the moment it unlocks — so even the off-screen
#      window never coexists with an active session.
#
# Rule of thumb: full suite = run while away; quiet mode keeps even that invisible.
#
# Usage:
#   bash scripts/e2e-quiet.sh                 # wait for lock, then run once
#   HPS_APP_PATH="/path/HypeProof Studio.app" bash scripts/e2e-quiet.sh
#   POLL=15 bash scripts/e2e-quiet.sh         # override 30s poll
#
# Requires pyobjc Quartz for lock detection:
#   pip3 install pyobjc-framework-Quartz
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
POLL="${POLL:-30}"

# Returns 0 when the macOS screen is locked, 1 otherwise (or if undetectable).
is_locked() {
  python3 - <<'PY' 2>/dev/null
import sys
try:
    import Quartz
    d = Quartz.CGSessionCopyCurrentDictionary()
    sys.exit(0 if (d and d.get("CGSSessionScreenIsLocked", 0)) else 1)
except Exception:
    # Quartz missing → cannot confirm locked → treat as UNLOCKED (safe: never
    # runs while we're unsure Jay is away).
    sys.exit(1)
PY
}

kill_app() {
  pkill -f "HypeProof Studio.app/Contents/MacOS/HypeProof Studio" 2>/dev/null || true
}

# Preflight: fail fast if lock detection is unavailable, so we never silently
# run unlocked.
if ! python3 -c 'import Quartz' >/dev/null 2>&1; then
  echo "✗ pyobjc Quartz not installed — cannot detect screen lock." >&2
  echo "  Install: pip3 install pyobjc-framework-Quartz" >&2
  exit 2
fi

echo "▶ waiting for screen lock (poll ${POLL}s)… lock the screen to start the suite."
until is_locked; do sleep "$POLL"; done

echo "▶ screen locked — starting full e2e suite (quiet mode)…"
( cd "$ROOT/e2e" && HPS_QUIET="${HPS_QUIET:-1}" npm test ) &
SUITE_PID=$!

# Watchdog: abort if the screen unlocks mid-run.
while kill -0 "$SUITE_PID" 2>/dev/null; do
  if ! is_locked; then
    echo "✗ screen unlocked → aborting suite + killing app." >&2
    kill "$SUITE_PID" 2>/dev/null || true
    kill_app
    wait "$SUITE_PID" 2>/dev/null || true
    exit 3
  fi
  sleep "$POLL"
done

wait "$SUITE_PID"
STATUS=$?
kill_app
echo "▶ suite finished (exit $STATUS) while locked."
exit "$STATUS"

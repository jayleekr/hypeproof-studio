#!/usr/bin/env bash
# e2e-quiet.sh — run local e2e invisibly, only while nobody is using the Mac.
#
# Layers of "don't interrupt the person at the keyboard":
#   1. Quiet mode (HPS_QUIET=1, the fixture default) keeps the Electron window
#      off-screen + the app hidden even while it runs.
#   2. A gate decides when a run may start and aborts it when the person returns:
#      - GATE=lock (default): start once the screen is locked, abort on unlock.
#        Screenshots and wheel scrolling do not work while locked (no composited
#        frames — see docs/plan/curriculum-runtime-recon.md F7).
#      - GATE=idle: start once the HID idle time reaches IDLE_MIN minutes with the
#        screen UNLOCKED, abort (exit 75) the moment keyboard/mouse input resumes.
#        Composited checks work. Requires HPS_APP_PATH pointing at a copy prepared
#        by scripts/prep-test-app.sh, so the test app never takes focus and the
#        abort only kills the copy, never the person's own Studio.
#
# Usage:
#   bash scripts/e2e-quiet.sh                                  # lock gate, full suite
#   GATE=idle HPS_APP_PATH="/tmp/hps-test/HypeProof Studio.app" bash scripts/e2e-quiet.sh
#   GATE=idle HPS_APP_PATH=... bash scripts/e2e-quiet.sh npx playwright test tests/09-preview.spec.ts
#   POLL=15 IDLE_MIN=3 ...                                     # override poll / idle threshold
#
# Arguments, when given, replace `npm test` and run inside e2e/.
# Exit 75 = aborted because the person came back; retry later.
#
# Requires pyobjc Quartz for lock detection:
#   pip3 install pyobjc-framework-Quartz
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
POLL="${POLL:-30}"
GATE="${GATE:-lock}"
IDLE_MIN="${IDLE_MIN:-5}"

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

# Seconds since the last keyboard/mouse input.
idle_seconds() {
  ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF / 1000000000); exit}'
}

kill_app() {
  if [[ "$GATE" == "idle" ]]; then
    # Only the prepared copy — the person at the keyboard may have Studio open.
    pkill -f "$HPS_APP_PATH/Contents/MacOS/" 2>/dev/null || true
  else
    pkill -f "HypeProof Studio.app/Contents/MacOS/HypeProof Studio" 2>/dev/null || true
  fi
}

# Preflight: fail fast if lock detection is unavailable, so we never silently
# run unlocked.
if ! python3 -c 'import Quartz' >/dev/null 2>&1; then
  echo "✗ pyobjc Quartz not installed — cannot detect screen lock." >&2
  echo "  Install: pip3 install pyobjc-framework-Quartz" >&2
  exit 2
fi

case "$GATE" in
  lock) ;;
  idle)
    APP_PLIST="${HPS_APP_PATH:-}/Contents/Info.plist"
    if [[ -z "${HPS_APP_PATH:-}" || ! -f "$APP_PLIST" ]] \
      || [[ "$(plutil -extract LSUIElement raw "$APP_PLIST" 2>/dev/null)" != "true" ]]; then
      echo "✗ GATE=idle needs HPS_APP_PATH set to a copy prepared by scripts/prep-test-app.sh" >&2
      exit 2
    fi
    ;;
  *) echo "✗ unknown GATE=$GATE (lock|idle)" >&2; exit 2 ;;
esac

# Still the person at the keyboard? (Gate-specific "they came back" check.)
person_present() {
  if [[ "$GATE" == "idle" ]]; then
    [[ "$(idle_seconds)" -lt 20 ]] || is_locked
  else
    ! is_locked
  fi
}

# ── GATE — must pass BEFORE any Electron launch ───────────────────────────────
# Nothing above this point launches the app. The suite (the sole launch site)
# starts only once the gate confirms nobody is using the machine.
if [[ "$GATE" == "idle" ]]; then
  echo "▶ waiting for ${IDLE_MIN} min without input (poll ${POLL}s)…"
  until [[ "$(idle_seconds)" -ge $((IDLE_MIN * 60)) ]] && ! is_locked; do sleep "$POLL"; done
  WATCH=5
else
  echo "▶ waiting for screen lock (poll ${POLL}s)… lock the screen to start the suite."
  until is_locked; do sleep "$POLL"; done
  WATCH="$POLL"
fi

echo "▶ gate passed ($GATE) — starting e2e (quiet mode)…"
if [[ $# -gt 0 ]]; then
  ( cd "$ROOT/e2e" && HPS_QUIET="${HPS_QUIET:-1}" "$@" ) &
else
  ( cd "$ROOT/e2e" && HPS_QUIET="${HPS_QUIET:-1}" npm test ) &
fi
SUITE_PID=$!

# Watchdog: abort if the person comes back mid-run.
while kill -0 "$SUITE_PID" 2>/dev/null; do
  if person_present; then
    echo "✗ input resumed ($GATE gate) → aborting suite + killing app." >&2
    kill "$SUITE_PID" 2>/dev/null || true
    kill_app
    wait "$SUITE_PID" 2>/dev/null || true
    [[ "$GATE" == "idle" ]] && exit 75
    exit 3
  fi
  sleep "$WATCH"
done

wait "$SUITE_PID"
STATUS=$?
kill_app
echo "▶ suite finished (exit $STATUS) behind the $GATE gate."
exit "$STATUS"

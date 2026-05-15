#!/usr/bin/env bash
# Collect HypeProof Studio environment as a single JSON object on stdout.
#
# Reused by:
#   - .claude/skills/report-ui  (embeds this into every contributor issue)
#   - any downstream solver skill (re-run to compare against the issue's snapshot)
#
# Contract: stdout is exactly one JSON object, nothing else. Never prints
# secrets (token, ANTHROPIC_API_KEY, .dev.vars values). Safe to run anywhere
# inside the repo; resolves the repo root itself.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/vscodium-base/VSCode-darwin-arm64/HypeProof Studio.app"
PLIST="$APP/Contents/Info.plist"

jstr() { # json-escape a string
  printf '%s' "${1:-}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

# --- OS ----------------------------------------------------------------------
OS_NAME="$(uname -s)"
OS_ARCH="$(uname -m)"
OS_VER="$(sw_vers -productVersion 2>/dev/null || echo unknown)"

# --- Toolchain ---------------------------------------------------------------
NODE_VER="$(node --version 2>/dev/null || echo absent)"

# --- Repo --------------------------------------------------------------------
GIT_SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
GIT_BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
GIT_DIRTY=false
git -C "$ROOT" diff --quiet 2>/dev/null || GIT_DIRTY=true
SUB_SHA="$(git -C "$ROOT/vscodium-base" rev-parse --short HEAD 2>/dev/null || echo unknown)"

# --- App ---------------------------------------------------------------------
APP_PRESENT=false; APP_BUNDLE_ID=unknown; APP_VER=unknown; APP_BUILT=unknown
if [[ -d "$APP" ]]; then
  APP_PRESENT=true
  APP_BUNDLE_ID="$(defaults read "$PLIST" CFBundleIdentifier 2>/dev/null | tail -1 || echo unknown)"
  APP_VER="$(defaults read "$PLIST" CFBundleShortVersionString 2>/dev/null | tail -1 || echo unset)"
  [[ -z "$APP_VER" ]] && APP_VER=unset
  APP_BUILT="$(date -r "$APP" +%Y-%m-%dT%H:%M:%S 2>/dev/null || echo unknown)"
fi

# --- Extension ---------------------------------------------------------------
EXT_VER="$(node -p "require('$ROOT/extensions/hypeproof-chat/package.json').version" 2>/dev/null || echo unknown)"

# --- Worker (local wrangler dev) — health only, no secrets -------------------
WORKER_UP=false; WORKER_HEALTH=null
if HEALTH="$(curl -fsS --max-time 3 http://localhost:8787/v1/health 2>/dev/null)"; then
  WORKER_UP=true
  # keep only well-known keys; never echo arbitrary response verbatim
  WORKER_HEALTH="$(printf '%s' "$HEALTH" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); print(json.dumps({k:d.get(k) for k in ("service","version","env","ok")}))
except Exception: print("null")')"
fi

cat <<JSON
{
  "schema": "hps-env/1",
  "captured_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "os": { "name": $(jstr "$OS_NAME"), "version": $(jstr "$OS_VER"), "arch": $(jstr "$OS_ARCH") },
  "node": $(jstr "$NODE_VER"),
  "repo": { "sha": $(jstr "$GIT_SHA"), "branch": $(jstr "$GIT_BRANCH"), "dirty": $GIT_DIRTY, "submodule_sha": $(jstr "$SUB_SHA") },
  "app": { "present": $APP_PRESENT, "bundle_id": $(jstr "$APP_BUNDLE_ID"), "version": $(jstr "$APP_VER"), "built_at": $(jstr "$APP_BUILT") },
  "extension": { "version": $(jstr "$EXT_VER") },
  "worker": { "running": $WORKER_UP, "health": $WORKER_HEALTH }
}
JSON

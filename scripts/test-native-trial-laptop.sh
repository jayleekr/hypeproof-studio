#!/usr/bin/env bash
# Mac laptop rehearsal. No full Studio build, deployment or production cohort.
# Run from this checkout; inputs: installed Studio app + worker/.dev.vars API key.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'BLOCKED: this rehearsal launches the macOS Studio app; run on the Mac laptop.' >&2
  exit 2
fi
SOURCE_APP="${HPS_APP_PATH:-/Applications/HypeProof Studio.app}"
[[ -d "$SOURCE_APP/Contents" ]] || { echo 'BLOCKED: set HPS_APP_PATH to an installed Studio .app bundle.' >&2; exit 2; }
[[ -f worker/.dev.vars ]] || { echo 'BLOCKED: worker/.dev.vars is missing; use the existing scripts/dev-secrets.sh setup.' >&2; exit 2; }
node --env-file=worker/.dev.vars -e 'if (!process.env.ANTHROPIC_API_KEY) { console.error("BLOCKED: this SDK rehearsal requires ANTHROPIC_API_KEY in worker/.dev.vars"); process.exit(2) }'
if curl --max-time 2 -fsS http://127.0.0.1:8787/v1/health >/dev/null 2>&1; then
  echo 'BLOCKED: port 8787 already has a gateway. Stop your own dev stack first; this script will not kill it.' >&2
  exit 2
fi

node e2e/native-trial-checks.test.mjs
if [[ -z "${HPS_NATIVE_REUSE_DIR:-}" ]]; then
npm ci --prefix worker
npm ci --prefix e2e
npm ci --prefix extensions/hypeproof-chat
npm ci --prefix extensions/hypeproof-chat/webview-ui
npm run build --prefix extensions/hypeproof-chat/webview-ui
npm run build:extension --prefix extensions/hypeproof-chat
bash scripts/seed-sdk-binary.sh

NATIVE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/hps-native-trial.XXXXXX")"
else
  NATIVE_TMP="$HPS_NATIVE_REUSE_DIR"
  [[ -d "$NATIVE_TMP/HypeProof Studio.app/Contents" ]] || { echo 'BLOCKED: reusable test copy missing' >&2; exit 2; }
fi
GATEWAY_PID=''
cleanup() {
  if [[ -n "$GATEWAY_PID" ]]; then kill "$GATEWAY_PID" 2>/dev/null || true; wait "$GATEWAY_PID" 2>/dev/null || true; fi
  rm -f "$NATIVE_TMP/token" "$NATIVE_TMP/token.alternate"
  echo "Rehearsal copy and gateway log: $NATIVE_TMP"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
if [[ -z "${HPS_NATIVE_REUSE_DIR:-}" ]]; then
ditto "$SOURCE_APP" "$NATIVE_TMP/HypeProof Studio.app"
NATIVE_EXT="$NATIVE_TMP/HypeProof Studio.app/Contents/Resources/app/extensions/hypeproof-chat"
mkdir -p "$NATIVE_EXT/webview-ui"
ditto extensions/hypeproof-chat/dist "$NATIVE_EXT/dist"
ditto extensions/hypeproof-chat/webview-ui/dist "$NATIVE_EXT/webview-ui/dist"
ditto extensions/hypeproof-chat/node_modules "$NATIVE_EXT/node_modules"
ditto extensions/hypeproof-chat/media "$NATIVE_EXT/media"
cp extensions/hypeproof-chat/package.json "$NATIVE_EXT/package.json"
fi

export HPS_APP_PATH="$NATIVE_TMP/HypeProof Studio.app"
node --input-type=module <<'NODE'
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
for (const file of ['dist/extension.js','webview-ui/dist/assets/index.js','webview-ui/dist/assets/index.css','package.json']) {
  const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex');
  assert.equal(hash(process.env.HPS_APP_PATH+'/Contents/Resources/app/extensions/hypeproof-chat/'+file), hash('extensions/hypeproof-chat/'+file), 'stale rehearsal copy: '+file);
}
NODE
# Explicit compatibility control: a preserved released app, never a baseline PASS.
if [[ -n "${HPS_NATIVE_COMPAT_APP:-}" ]]; then
  [[ "${HPS_NATIVE_FAULTS:-}" == 1 && "${HPS_NATIVE_CASE:-}" == old-client ]] || { echo 'compatibility app requires the old-client test' >&2; exit 2; }
  export HPS_APP_PATH="$HPS_NATIVE_COMPAT_APP"
fi
export HPS_E2E_TOKEN_FILE="$NATIVE_TMP/token"
export HPS_E2E_PROXY_URL='http://127.0.0.1:8787/v1'
export HPS_NATIVE_LIVE=1
export HPS_NATIVE_EVIDENCE_DIR="$ROOT/e2e/test-results/native-trial/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$HPS_NATIVE_EVIDENCE_DIR"
node e2e/native-trial-manifest.mjs
node --env-file=worker/.dev.vars --experimental-strip-types worker/test/native-trial-live-server.mjs > "$NATIVE_TMP/gateway.log" 2>&1 &
GATEWAY_PID=$!
ready=0
for attempt in {1..30}; do
  if curl --max-time 2 -fsS http://127.0.0.1:8787/v1/health >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || { echo "BLOCKED: gateway startup failed; inspect $NATIVE_TMP/gateway.log locally." >&2; exit 2; }
cd e2e
echo "Evidence: $HPS_NATIVE_EVIDENCE_DIR"
npx playwright test --config=native-trial.config.ts --workers=1 --retries=0

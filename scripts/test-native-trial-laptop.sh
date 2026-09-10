#!/usr/bin/env bash
# Mac laptop rehearsal. No full Studio build, deployment or production cohort.
# Run from this checkout; inputs: installed Studio app + worker/.dev.vars API key.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
GATEWAY_PORT="${HPS_NATIVE_PORT:-8787}"
[[ "$GATEWAY_PORT" =~ ^[0-9]{1,5}$ ]] && (( 10#$GATEWAY_PORT >= 1024 && 10#$GATEWAY_PORT <= 65535 )) || { echo 'BLOCKED: HPS_NATIVE_PORT must be an integer from 1024 to 65535' >&2; exit 2; }
export HPS_NATIVE_PORT="$GATEWAY_PORT"
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'BLOCKED: this rehearsal launches the macOS Studio app; run on the Mac laptop.' >&2
  exit 2
fi
SOURCE_APP="${HPS_APP_PATH:-/Applications/HypeProof Studio.app}"
if [[ "${HPS_NATIVE_RELEASE_VERIFY:-}" == 1 && -z "${HPS_NATIVE_REUSE_DIR:-}" ]]; then
  echo 'BLOCKED: release verification requires HPS_NATIVE_REUSE_DIR containing the untouched published .app; injection is forbidden.' >&2
  exit 2
fi
[[ -d "$SOURCE_APP/Contents" ]] || { echo 'BLOCKED: set HPS_APP_PATH to an installed Studio .app bundle.' >&2; exit 2; }
[[ -f worker/.dev.vars ]] || { echo 'BLOCKED: worker/.dev.vars is missing; use the existing scripts/dev-secrets.sh setup.' >&2; exit 2; }
node --env-file=worker/.dev.vars -e 'if (process.env.HPS_CODEX_REHEARSAL !== "1" && !process.env.ANTHROPIC_API_KEY) { console.error("BLOCKED: this SDK rehearsal requires ANTHROPIC_API_KEY in worker/.dev.vars"); process.exit(2) }'
if curl --max-time 2 -fsS "http://127.0.0.1:$GATEWAY_PORT/v1/health" >/dev/null 2>&1; then
  echo "BLOCKED: port $GATEWAY_PORT already has a gateway. Set HPS_NATIVE_PORT to an unused test port; this script will not kill it." >&2
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
  if [[ -n "${HPS_NATIVE_TEST_APP_NAME:-}" ]]; then
    security delete-generic-password -s "$HPS_NATIVE_TEST_APP_NAME Safe Storage" >/dev/null 2>&1 || true
  fi
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
# A synthetic persistent-storage rehearsal must not access the user's existing
# app encryption key. Keep real SecretStorage, with a distinct test app identity.
if [[ "${HPS_NATIVE_ISOLATED_KEYCHAIN:-}" == 1 ]]; then
  [[ "${HPS_NATIVE_RELEASE_VERIFY:-}" != 1 ]] || { echo 'BLOCKED: release identity cannot be rewritten' >&2; exit 2; }
  export HPS_NATIVE_TEST_APP_NAME="HypeProof Studio Synthetic $(node -p 'crypto.randomUUID()')"
  node --input-type=module <<'IDENTITY'
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const root=process.env.HPS_APP_PATH+'/Contents',name=process.env.HPS_NATIVE_TEST_APP_NAME;
for(const file of ['package.json','product.json']){
 const path=root+'/Resources/app/'+file,data=JSON.parse(readFileSync(path,'utf8'));
 if(file==='package.json')data.name=name;
 else {data.nameShort=data.nameLong=name;data.darwinBundleIdentifier='ai.hypeproof.studio.synthetic';}
 writeFileSync(path,JSON.stringify(data,null,2));
}
for(const [key,value] of [['CFBundleName','HypeProof Studio'],['CFBundleDisplayName','HypeProof Studio'],['CFBundleIdentifier','ai.hypeproof.studio']])
 execFileSync('/usr/libexec/PlistBuddy',['-c','Set :'+key+' '+value,root+'/Info.plist']);
execFileSync('/usr/bin/codesign',['--force','--sign','-','--preserve-metadata=entitlements,flags',process.env.HPS_APP_PATH],{stdio:'pipe'});
IDENTITY
fi
node --input-type=module <<'NODE'
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
if (process.env.HPS_NATIVE_RELEASE_VERIFY === '1') {
  // Download digest verification precedes this script. Never rebuild/inject a
  // published bundle and then describe it as verification of that release.
  assert.match(process.env.HPS_NATIVE_RELEASE_SHA ?? '', /^[0-9a-f]{40}$/);
  assert.match(process.env.HPS_NATIVE_RELEASE_VERSION ?? '', /^\d+\.\d+\.\d+$/);
  const product = JSON.parse(readFileSync(process.env.HPS_APP_PATH+'/Contents/Resources/app/product.json','utf8'));
  const extension = JSON.parse(readFileSync(process.env.HPS_APP_PATH+'/Contents/Resources/app/extensions/hypeproof-chat/package.json','utf8'));
  assert.equal(product.version, process.env.HPS_NATIVE_RELEASE_VERSION, 'wrong released app version');
  assert.equal(product.commit, process.env.HPS_NATIVE_RELEASE_SHA, 'wrong released app source');
  assert.equal(extension.version, process.env.HPS_NATIVE_RELEASE_VERSION, 'wrong bundled extension version');
  console.log('Untouched release bundle identity verified: '+product.version+' @ '+product.commit);
} else for (const file of ['dist/extension.js','webview-ui/dist/assets/index.js','webview-ui/dist/assets/index.css','package.json']) {
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
export HPS_E2E_PROXY_URL="http://127.0.0.1:$GATEWAY_PORT/v1"
export HPS_NATIVE_LIVE=1
export HPS_NATIVE_EVIDENCE_DIR="$ROOT/e2e/test-results/native-trial/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$HPS_NATIVE_EVIDENCE_DIR"
node e2e/native-trial-manifest.mjs
node --env-file=worker/.dev.vars --experimental-strip-types worker/test/native-trial-live-server.mjs > "$NATIVE_TMP/gateway.log" 2>&1 &
GATEWAY_PID=$!
ready=0
for attempt in {1..30}; do
  if curl --max-time 2 -fsS "http://127.0.0.1:$GATEWAY_PORT/v1/health" >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || { echo "BLOCKED: gateway startup failed; inspect $NATIVE_TMP/gateway.log locally." >&2; exit 2; }
cd e2e
echo "Evidence: $HPS_NATIVE_EVIDENCE_DIR"
npx playwright test --config=native-trial.config.ts --workers=1 --retries=0 "$@"

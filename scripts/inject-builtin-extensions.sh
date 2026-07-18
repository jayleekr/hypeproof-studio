#!/usr/bin/env bash
# Phase 5 — inject hypeproof-chat as a built-in extension into VS Code source.
# Runs AFTER prepare_vscode.sh (which creates vscodium-base/vscode/).
# Idempotent — safe to re-run.
#
# Usage (from repo root):
#   source ./hypeproof-studio.env
#   cd vscodium-base
#   bash prepare_vscode.sh
#   bash ../scripts/apply-product-overrides.sh
#   bash ../scripts/inject-builtin-extensions.sh
#   bash build.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_SRC="$REPO_ROOT/extensions/hypeproof-chat"
VSCODE_TREE="${VSCODE_TREE:-$REPO_ROOT/vscodium-base/vscode}"

if [[ ! -d "$VSCODE_TREE" ]]; then
  echo "ERROR: $VSCODE_TREE not found. Run prepare_vscode.sh first." >&2
  exit 1
fi

if [[ ! -d "$EXT_SRC" ]]; then
  echo "ERROR: $EXT_SRC not found." >&2
  exit 1
fi

EXT_DST="$VSCODE_TREE/extensions/hypeproof-chat"
PRODUCT_JSON="$VSCODE_TREE/product.json"

# 1. Build the webview + extension bundle
echo "Building hypeproof-chat..."
(
  cd "$EXT_SRC"
  if [[ ! -d node_modules ]]; then npm install --no-audit --no-fund; fi
  npm run build
)

# 1b. Vendor the Agent SDK JS (#282 W4b, docs/sdk-bundling.md §5 step 1) into
# dist/vendor so a PACKAGED build can actually load the SDK. loadSdk() tries
# <dist>/vendor first; without this the packaged built-in has no SDK JS (only
# dist/ + webview-ui/dist + media + package.json ship), so the SDK import fails
# and the coach falls back to the proxy runtime even with a seeded binary.
#
# The 229 MB per-platform native binaries are EXCLUDED (--omit=optional) — those
# reach students via the W4a seed (scripts/seed-sdk-binary.sh), NOT the app
# bundle (embedding would clobber Anthropic's Developer-ID signature; doc §2.4).
# We also --omit=peer: sdk.mjs imports only ajv/ajv-formats at runtime (verified
# below by importing it), not the heavy peer deps (@anthropic-ai/sdk, express,
# hono…), so peers would just bloat the bundle 40 MB→ needlessly.
#
# CRITICAL (re-inject constraint): vendor into the SOURCE dist/, exactly like
# the version stamp below writes the SOURCE package.json. The fork's
# prepare_vscode.sh "HypeProof Studio overrides" hook re-injects from $EXT_SRC
# during build.sh (AFTER run-build's git clean wipes vscode/extensions/) by
# copying dist/ wholesale — so a vendor tree UNDER dist/ ships via BOTH this
# inject path and the build.sh re-inject, with no vscodium-base change.
echo "Vendoring Agent SDK JS into dist/vendor (platform binaries excluded)..."
# Path goes through argv, NOT interpolated into the -e source: on the Windows
# runner (Git Bash) $EXT_SRC is an MSYS path (/d/a/…) that node's require()
# can't resolve, but MSYS auto-converts argv paths to native ones (#355).
SDK_VERSION="$(node -e "const fs=require('fs');const lock=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(lock.packages['node_modules/@anthropic-ai/claude-agent-sdk'].version)" "$EXT_SRC/package-lock.json")"
VENDOR_ROOT="$EXT_SRC/dist/vendor"
rm -rf "$VENDOR_ROOT"
mkdir -p "$VENDOR_ROOT"
cat > "$VENDOR_ROOT/package.json" <<JSON
{ "name": "hypeproof-sdk-vendor", "private": true, "version": "0.0.0" }
JSON
(
  cd "$VENDOR_ROOT"
  # ajv/ajv-formats: sdk.mjs's direct runtime imports (belt over the closure
  # npm resolves). zod: the SDK peer used by the browser MCP tool schemas.
  npm install --no-audit --no-fund --omit=optional --omit=dev --omit=peer \
    "@anthropic-ai/claude-agent-sdk@${SDK_VERSION}" ajv ajv-formats zod
)

# 1c. Vendor guards — fail the build rather than ship a broken/oversized vendor.
VENDOR_SDK_ENTRY="$VENDOR_ROOT/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"
VENDOR_ZOD_ENTRY="$VENDOR_ROOT/node_modules/zod/index.js"
if [[ ! -f "$VENDOR_SDK_ENTRY" ]]; then
  echo "ERROR: vendored SDK entry missing: $VENDOR_SDK_ENTRY" >&2
  exit 1
fi
if [[ ! -f "$VENDOR_ZOD_ENTRY" ]]; then
  echo "ERROR: vendored zod entry missing: $VENDOR_ZOD_ENTRY" >&2
  exit 1
fi
# The platform-binary packages (@anthropic-ai/claude-agent-sdk-<platform>) are
# ~229 MB each and must NEVER land in the app bundle (W4a seeds the binary).
if ls -d "$VENDOR_ROOT"/node_modules/@anthropic-ai/claude-agent-sdk-* >/dev/null 2>&1; then
  echo "ERROR: a platform-binary package leaked into dist/vendor — the SDK binary must be seeded (W4a), not shipped" >&2
  exit 1
fi
# Coarse ceiling: the JS closure is ~13 MB; a >50 MB file means a binary slipped in.
BIG_FILE="$(find "$VENDOR_ROOT" -type f -size +50M 2>/dev/null | head -1)"
if [[ -n "$BIG_FILE" ]]; then
  echo "ERROR: oversized file in dist/vendor (binary leak?): $BIG_FILE" >&2
  exit 1
fi
# Strongest guard: actually import the vendored SDK JS from its own tree (proves
# the runtime closure — ajv/ajv-formats included — is complete, not just present).
if ! node --input-type=module -e "import { pathToFileURL } from 'node:url'; const m = await import(pathToFileURL(process.argv[1]).href); if (typeof m.query !== 'function') { console.error('vendored SDK missing query()'); process.exit(1); }" "$VENDOR_SDK_ENTRY"; then
  echo "ERROR: vendored SDK JS failed to import from dist/vendor (incomplete runtime closure?)" >&2
  exit 1
fi
VENDOR_SIZE="$(du -sh "$VENDOR_ROOT" | cut -f1)"
echo "Vendored Agent SDK JS closure → dist/vendor ($VENDOR_SIZE, SDK $SDK_VERSION, native binaries excluded)"

# 2. Copy the built extension into vscode/extensions/
echo "Injecting into $EXT_DST"
rm -rf "$EXT_DST"
mkdir -p "$EXT_DST"
# Files that ship inside the bundled extension:
cp "$EXT_SRC/package.json"  "$EXT_DST/"
# dist/ carries the esbuild bundle AND the vendored Agent SDK JS (dist/vendor,
# step 1b) — cp -r ships both, same as the fork's prepare_vscode.sh re-inject.
cp -r "$EXT_SRC/dist"       "$EXT_DST/"
cp -r "$EXT_SRC/media"      "$EXT_DST/"
mkdir -p "$EXT_DST/webview-ui"
cp -r "$EXT_SRC/webview-ui/dist" "$EXT_DST/webview-ui/dist"

# 2b. Stamp the bundled extension's version to the release version. The in-app
# updater's currentBundleVersion() reads this package.json to decide whether an
# update is available; if it stays at the dev version while releases are tagged
# ahead, every install reports out-of-date forever (#206).
#
# CRITICAL: stamp the SOURCE package.json, not just the vscode/ copy. The fork's
# prepare_vscode.sh "HypeProof Studio overrides" hook re-injects from
# $EXT_SRC during build.sh — AFTER run-build.sh's `git clean -fdx` wipes
# vscode/extensions/ — by copying $EXT_SRC/package.json verbatim. So the SOURCE
# version is what actually ships. run-build's reset only touches vscode/, so a
# source stamp set here (an explicit step before run-build) survives to the
# hook. We stamp the copy too for standalone/F5 correctness.
RESOLVED_VERSION="$(bash "$REPO_ROOT/scripts/resolve-version.sh")"
for pkg in "$EXT_SRC/package.json" "$EXT_DST/package.json"; do
  tmp_pkg=$(mktemp)
  jq --arg v "$RESOLVED_VERSION" '.version = $v' "$pkg" > "$tmp_pkg"
  mv "$tmp_pkg" "$pkg"
done
echo "Stamped extension version (source + bundled copy) → $RESOLVED_VERSION"

# 3. NOTE: do NOT add to product.json.builtInExtensions. That list triggers
# a marketplace/GH download at build time. Extensions placed in extensions/
# at build time are bundled automatically — same mechanism vscode itself
# uses for git, npm, css-language-features, etc.

echo "Done. hypeproof-chat copied to vscode/extensions/ — will ship pre-installed."
echo "Verify: ls $VSCODE_TREE/extensions/hypeproof-chat/"

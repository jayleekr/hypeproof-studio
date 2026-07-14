#!/usr/bin/env bash
# Phase 3 decision gate + post-build branding integrity (#98).
#
# Closes the REQ-J1·J2·J3·J4 row of epic #89 (docs/studio-requirements.md):
#   REQ-J1 — App display name == "HypeProof Studio" (check 1)
#   REQ-J2 — CFBundleIdentifier == "ai.hypeproof.studio" (check 2)
#   REQ-J3 — Data folder exists after first launch (check 7)
#   REQ-J4 — No "VSCodium"/"codium" leakage in Resources/ outside legal
#            attribution (check 5)
#
# Run after every `bash scripts/run-build.sh`. Non-zero exit blocks release.
#
# Usage:
#   bash scripts/verify-branding.sh [path-to.app]
# Default: vscodium-base/VSCode-darwin-arm64/HypeProof Studio.app

set -uo pipefail

APP="${1:-vscodium-base/VSCode-darwin-arm64/HypeProof Studio.app}"

if [[ ! -d "$APP" ]]; then
  echo "ERROR: $APP not found. Did the build succeed?" >&2
  echo "Look for the actual produced bundle:" >&2
  ls -1 vscodium-base/VSCode-darwin-arm64/ 2>/dev/null | sed 's/^/  /' >&2
  exit 2
fi

PASS=0; FAIL=0

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL+1)); }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }

echo "Verifying $APP"
echo

# 1. Display name. Read Info.plist instead of Spotlight metadata: mdls is null
# for uninstalled build-dir apps and in CI, which made this gate unsatisfiable.
DISP=$(defaults read "$APP/Contents/Info" CFBundleDisplayName 2>/dev/null || true)
[[ -n "$DISP" ]] || DISP=$(defaults read "$APP/Contents/Info" CFBundleName 2>/dev/null || true)
if [[ "$DISP" == "HypeProof Studio" ]]; then
  ok "Display name: $DISP"
else
  bad "Display name: $DISP (expected HypeProof Studio)"
fi

# 2. Bundle identifier
BID=$(defaults read "$APP/Contents/Info" CFBundleIdentifier 2>/dev/null || true)
if [[ "$BID" == "ai.hypeproof.studio" ]]; then
  ok "Bundle ID: $BID"
else
  bad "Bundle ID: $BID (expected ai.hypeproof.studio)"
fi

# 3. Bundle name
BNAME=$(defaults read "$APP/Contents/Info" CFBundleName 2>/dev/null || true)
if [[ "$BNAME" == "HypeProof Studio" ]]; then
  ok "Bundle name: $BNAME"
else
  bad "Bundle name: $BNAME"
fi

# 4. URL protocol handler
URLS=$(defaults read "$APP/Contents/Info" CFBundleURLTypes 2>/dev/null | grep -i "hypeproof-studio" || true)
if [[ -n "$URLS" ]]; then
  ok "URL protocol registered: hypeproof-studio"
else
  warn "URL protocol 'hypeproof-studio' not found in Info.plist"
fi

# 5. Residual strings (excluding license/attribution)
echo
echo "Scanning Resources/ for residual 'codium'/'VSCodium' (excluding licenses)..."
HITS=$(grep -ril "codium" "$APP/Contents/Resources" 2>/dev/null \
  | grep -viE "license|notice|attribution|third.?party|credits" || true)
if [[ -z "$HITS" ]]; then
  ok "No residual branding in Resources/"
else
  bad "Residual 'codium' found in:"
  echo "$HITS" | sed 's/^/      /'
fi

# 6. product.json baked into the app
PJSON=$(find "$APP/Contents/Resources" -name "product.json" 2>/dev/null | head -1)
if [[ -n "$PJSON" ]]; then
  NS=$(jq -r '.nameShort' "$PJSON")
  NL=$(jq -r '.nameLong' "$PJSON")
  AN=$(jq -r '.applicationName' "$PJSON")
  DBI=$(jq -r '.darwinBundleIdentifier' "$PJSON")
  TUNNEL_APP=$(jq -r '.tunnelApplicationName // ""' "$PJSON")
  WIN_SHELL=$(jq -r '.win32ShellNameShort // ""' "$PJSON")
  WIN_TUNNEL_SERVICE=$(jq -r '.win32TunnelServiceMutex // ""' "$PJSON")
  WIN_TUNNEL=$(jq -r '.win32TunnelMutex // ""' "$PJSON")
  LINUX_ICON=$(jq -r '.linuxIconName // ""' "$PJSON")
  if [[ "$NS" == "HypeProof Studio" && "$AN" == "hypeproof-studio" && "$DBI" == "ai.hypeproof.studio" \
        && "$TUNNEL_APP" == "hypeproof-studio-tunnel" && "$WIN_SHELL" == "HypeProof Studio" \
        && "$WIN_TUNNEL_SERVICE" == "hypeproof-studio-tunnelservice" \
        && "$WIN_TUNNEL" == "hypeproof-studio-tunnel" && "$LINUX_ICON" == "hypeproof-studio" ]]; then
    ok "product.json: nameShort=$NS, applicationName=$AN, darwinBundleId=$DBI, tunnel=$TUNNEL_APP, linuxIcon=$LINUX_ICON"
  else
    bad "product.json mismatch: nameShort=$NS, nameLong=$NL, applicationName=$AN, darwinBundleId=$DBI, tunnelApplicationName=$TUNNEL_APP, win32ShellNameShort=$WIN_SHELL, win32TunnelServiceMutex=$WIN_TUNNEL_SERVICE, win32TunnelMutex=$WIN_TUNNEL, linuxIconName=$LINUX_ICON"
  fi

  # 6b. Version must be present + non-placeholder, and the bundled extension's
  # version must match it. An empty/placeholder version makes the in-app updater
  # loop forever (#206), so this is a release gate, not a nicety.
  PVER=$(jq -r '.version // ""' "$PJSON")
  PCOMMIT=$(jq -r '.commit // ""' "$PJSON")
  EXT_PKG=$(find "$APP/Contents/Resources/app" -maxdepth 4 -path "*hypeproof-chat/package.json" 2>/dev/null | head -1)
  EXT_VER=$([[ -n "$EXT_PKG" ]] && jq -r '.version // ""' "$EXT_PKG" || echo "")
  if [[ -z "$PVER" ]]; then
    bad "product.json.version is EMPTY — build did not inject a version (#206)"
  elif [[ "$PCOMMIT" == "adc83b19e793491b1c6ea0fd8b46cd9f32e592fc" ]]; then
    bad "product.json.commit is the placeholder (version metadata not injected) (#206)"
  elif [[ -n "$EXT_VER" && "$EXT_VER" != "$PVER" ]]; then
    bad "version mismatch: product.json=$PVER but bundled extension=$EXT_VER (updater will misfire) (#206)"
  else
    ok "version: product.json=$PVER, bundled extension=${EXT_VER:-<none>}, commit=${PCOMMIT:0:10}"
  fi
else
  bad "product.json not found inside .app"
fi

# 7. Data folder check (only meaningful after launch — informational)
DATA_DIR="$HOME/Library/Application Support/HypeProof Studio"
if [[ -d "$DATA_DIR" ]]; then
  ok "Data folder exists: $DATA_DIR (app has been launched at least once)"
else
  warn "Data folder not yet created — launch the app once, then re-run this check"
fi

# 8. hypeproof-chat extension bundled?
echo
echo "Checking hypeproof-chat is bundled..."
EXT_DIR=$(find "$APP/Contents/Resources/app" -maxdepth 3 -name "hypeproof-chat" -type d 2>/dev/null | head -1)
if [[ -n "$EXT_DIR" ]]; then
  ok "Extension directory present: $EXT_DIR"
  if [[ -f "$EXT_DIR/dist/extension.js" ]]; then
    ok "Extension bundle present (dist/extension.js)"
  else
    bad "Extension dir present but dist/extension.js MISSING"
  fi
  if [[ -f "$EXT_DIR/webview-ui/dist/index.html" ]]; then
    ok "Webview UI present"
  else
    bad "Webview UI MISSING"
  fi
else
  bad "hypeproof-chat extension NOT bundled into the .app"
fi

# 8b. Vendored Agent SDK JS shipped? (#282 W4b · #343 review)
# A PACKAGED build loads the Agent SDK via a variable-specifier dynamic import
# that esbuild never bundles; sdkCoach.loadSdk() therefore falls back to the
# vendored copy under dist/vendor/node_modules (see
# extensions/hypeproof-chat/src/sdkCoachHelpers.ts VENDORED_SDK_ENTRY_SUBPATH,
# written by scripts/inject-builtin-extensions.sh). If that vendor tree is
# absent the SDK import throws and the coach SILENTLY degrades to the proxy-only
# runtime — even on an SDK release. That silent proxy-only ship is the release
# defect #343 caught, so this is a hard gate for SDK-coach builds.
#
# Trigger (so pre-SDK / pure-vanilla builds never false-fail):
#   * REQUIRE_SDK_VENDOR=1        → always assert (explicit CI/release gate)
#   * else auto-detect: assert only when the bundled extension's package.json
#     declares the "@anthropic-ai/claude-agent-sdk" dependency (i.e. this build
#     is an SDK-coach build). A vanilla build (no hypeproof-chat) or a pre-SDK
#     extension (no such dep) is SKIPPED with an informational note.
echo
echo "Checking vendored Agent SDK JS (SDK-coach builds only)..."
SDK_DEP=""
if [[ -n "$EXT_DIR" && -f "$EXT_DIR/package.json" ]]; then
  SDK_DEP=$(jq -r '.dependencies["@anthropic-ai/claude-agent-sdk"] // ""' "$EXT_DIR/package.json" 2>/dev/null || echo "")
fi
if [[ "${REQUIRE_SDK_VENDOR:-0}" == "1" || -n "$SDK_DEP" ]]; then
  if [[ "${REQUIRE_SDK_VENDOR:-0}" == "1" ]]; then
    SDK_TRIGGER="REQUIRE_SDK_VENDOR=1"
  else
    SDK_TRIGGER="extension declares @anthropic-ai/claude-agent-sdk"
  fi
  if [[ -z "$EXT_DIR" ]]; then
    bad "SDK vendor required ($SDK_TRIGGER) but hypeproof-chat is not bundled — cannot ship the SDK coach"
  else
    VENDOR_SDK_ENTRY="$EXT_DIR/dist/vendor/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"
    if [[ -f "$VENDOR_SDK_ENTRY" ]]; then
      ok "Vendored SDK entrypoint shipped (dist/vendor/.../claude-agent-sdk/sdk.mjs) [$SDK_TRIGGER]"
    else
      bad "Vendored SDK entrypoint MISSING at $VENDOR_SDK_ENTRY — packaged build will SILENTLY fall back to the proxy-only coach (#343) [$SDK_TRIGGER]"
    fi
    # The 229 MB per-platform native binary packages (claude-agent-sdk-<platform>)
    # must NEVER land in the shipped bundle — they reach students via the W4a seed
    # (scripts/seed-sdk-binary.sh); bundling them clobbers Anthropic's Developer-ID
    # signature. `find` (not a shell glob) so an empty match is safe under zsh too.
    LEAKED_BIN=$(find "$EXT_DIR/dist/vendor/node_modules/@anthropic-ai" -maxdepth 1 -type d -name 'claude-agent-sdk-*' 2>/dev/null || true)
    if [[ -z "$LEAKED_BIN" ]]; then
      ok "No per-platform SDK binary package leaked into the shipped vendor tree"
    else
      bad "Per-platform SDK binary package(s) leaked into the shipped vendor (must be seeded, not bundled):"
      echo "$LEAKED_BIN" | sed 's/^/      /'
    fi
  fi
else
  warn "No SDK-coach vendor expected (bundled extension has no @anthropic-ai/claude-agent-sdk dep; set REQUIRE_SDK_VENDOR=1 to force) — skipping"
fi

# 9. builtInExtensions list should NOT contain us. hypeproof-chat ships by
# being copied into Resources/app/extensions; listing it in product.json makes
# VSCodium try a marketplace/GitHub download during build, which 404s.
if [[ -n "$PJSON" ]]; then
  BUILT_IN_HIT=$(jq -r '.builtInExtensions[]?.name // empty' "$PJSON" | grep -c "hypeproof" || true)
  if [[ "$BUILT_IN_HIT" -eq 0 ]]; then
    ok "Not listed in product.json.builtInExtensions (bundled via extensions/)"
  else
    bad "Unexpected product.json.builtInExtensions entry for hypeproof-chat"
  fi
fi

# 10. Icon is HPS (Mac .icns)
ICNS="$APP/Contents/Resources/Code.icns"
[[ -f "$ICNS" ]] || ICNS=$(find "$APP/Contents/Resources" -name "*.icns" -maxdepth 1 | head -1)
if [[ -f "$ICNS" ]]; then
  ICNS_SIZE=$(stat -f %z "$ICNS")
  # HPS .icns is ~351KB; VSCodium's is ~640KB. Rough check.
  if [[ "$ICNS_SIZE" -lt 500000 && "$ICNS_SIZE" -gt 50000 ]]; then
    ok "App icon looks like HPS (size $ICNS_SIZE bytes)"
  else
    warn "App icon size $ICNS_SIZE bytes — may be VSCodium fallback. Inspect manually."
  fi
fi

echo
echo "Result: $PASS passed, $FAIL failed"
exit $(( FAIL > 0 ? 1 : 0 ))

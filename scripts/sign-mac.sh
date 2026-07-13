#!/usr/bin/env bash
# Re-seal the built macOS .app so its code signature is VALID.
#
# WHY THIS EXISTS
# ---------------
# Electron ships its binaries ad-hoc signed. Our build then MODIFIES the bundle
# (injects the hypeproof-chat extension, rewrites product.json/package.json), which
# breaks the existing seal. The shipped app ends up in the worst possible state:
#
#     codesign --verify   → exit 1  ("code has no resources but signature
#                                     indicates they must be present")
#     Contents/_CodeSignature/ → missing
#
# That is a *malformed* signature, not merely an unsigned app — and the two behave
# very differently once the download carries a quarantine flag:
#
#   malformed signature  → "‘HypeProof Studio’이(가) 손상되었기 때문에 열 수 없습니다.
#                           휴지통으로 이동해야 합니다."   ← NO "Open Anyway". Dead end.
#   valid but unnotarized→ "개발자를 확인할 수 없습니다"    ← System Settings ▸
#                           Privacy & Security ▸ "Open Anyway" works.
#
# Re-signing ad-hoc costs nothing (no Apple Developer certificate needed) and moves
# us from the dead end to the recoverable path. Verified on the real v0.1.15
# release artifact: verify exit 1 → 0, seal restored (4959 files), and the bundle
# identifier is corrected from "Electron" to ai.hypeproof.studio as a side effect.
#
# THE REAL FIX (still open)
# -------------------------
# A Developer ID certificate + notarization removes the Gatekeeper prompt entirely.
# VSCodium's build/osx/prepare_assets.sh already implements it end-to-end (codesign
# → notarytool → stapler); it is skipped because CERTIFICATE_OSX_P12_DATA is unset.
# Set CODESIGN_IDENTITY to a Developer ID to sign with it here, but note that a
# notarization-grade signature also needs inside-out signing of nested code — use
# prepare_assets.sh with the certificate secrets for that, not this script.
#
# Usage: bash scripts/sign-mac.sh [path/to/App.app]
#        CODESIGN_IDENTITY=- (default: ad-hoc)

set -euo pipefail

APP="${1:-}"
if [ -z "$APP" ]; then
  OUT_DIR="vscodium-base/VSCode-darwin-arm64"
  APP="$(cd "$OUT_DIR" 2>/dev/null && ls -d ./*.app 2>/dev/null | head -1 || true)"
  [ -n "$APP" ] || { echo "✗ no .app found in $OUT_DIR (pass one explicitly)"; exit 1; }
  APP="$OUT_DIR/${APP#./}"
fi
[ -d "$APP" ] || { echo "✗ not a bundle: $APP"; exit 1; }

IDENTITY="${CODESIGN_IDENTITY:--}"
if [ "$IDENTITY" = "-" ]; then
  echo "▸ ad-hoc re-sign (no certificate): $APP"
else
  echo "▸ signing with identity '$IDENTITY': $APP"
fi

codesign --force --deep --sign "$IDENTITY" "$APP"

# Hard gate — a malformed signature must never reach a release again.
if ! codesign --verify --deep --strict "$APP" 2>/dev/null; then
  echo "::error::codesign --verify FAILED after signing — the bundle seal is broken."
  codesign --verify --deep --strict --verbose=2 "$APP" || true
  exit 1
fi
[ -f "$APP/Contents/_CodeSignature/CodeResources" ] || {
  echo "::error::_CodeSignature/CodeResources missing — bundle is not sealed."
  exit 1
}

echo "✓ signature valid + bundle sealed"
codesign -dvv "$APP" 2>&1 | grep -E "Identifier=|Signature=|Sealed" | sed 's/^/  /' || true

# Gatekeeper still rejects an unnotarized download — expected, and NOT an error.
# The point of this script is that the rejection is now the recoverable
# "unidentified developer" kind rather than the dead-end "damaged" kind.
if ! spctl -a -t exec "$APP" >/dev/null 2>&1; then
  echo "! Gatekeeper: rejected (unnotarized) — expected without a Developer ID."
  echo "  Users must approve once via System Settings ▸ Privacy & Security ▸ 'Open Anyway'."
  echo "  (Control-click ▸ Open no longer works: Apple removed it in macOS 15+.)"
fi

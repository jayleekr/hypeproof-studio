#!/usr/bin/env bash
# One-line installer for HypeProof Studio on macOS.
#
# Usage (family members run this in Terminal):
#   curl -fsSL https://hypeproof.ai/install | bash
# or:
#   curl -fsSL https://raw.githubusercontent.com/jayleekr/hypeproof-studio/main/scripts/install-mac.sh | bash

set -euo pipefail

REPO="jayleekr/hypeproof-studio"
APP_NAME="HypeProof Studio"
TAG="${HPS_VERSION:-latest}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say() { printf "\n\033[1;35m▶ %s\033[0m\n" "$*"; }
err() { printf "\033[1;31mERROR:\033[0m %s\n" "$*" >&2; exit 1; }

# 1. Arch check
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  ASSET_SUFFIX="darwin-arm64.zip" ;;
  x86_64) ASSET_SUFFIX="darwin-x64.zip"   ;;
  *) err "Unsupported architecture: $ARCH" ;;
esac

# 2. Resolve download URL
if [[ "$TAG" == "latest" ]]; then
  API="https://api.github.com/repos/$REPO/releases/latest"
else
  API="https://api.github.com/repos/$REPO/releases/tags/$TAG"
fi

say "Looking up release ($TAG)..."
URL=$(curl -fsSL "$API" \
  | grep "browser_download_url" \
  | grep "$ASSET_SUFFIX" \
  | head -1 \
  | sed -E 's/.*"(https[^"]+)".*/\1/') || true

[[ -n "$URL" ]] || err "Could not find $ASSET_SUFFIX in $TAG release. Visit https://github.com/$REPO/releases"

# 3. Download
say "Downloading $URL"
curl -fL "$URL" -o "$TMP/hps.zip"

# 4. Extract
say "Extracting..."
(cd "$TMP" && unzip -q hps.zip)

APP_PATH=$(find "$TMP" -maxdepth 3 -name "$APP_NAME.app" -type d | head -1)
[[ -n "$APP_PATH" ]] || err "$APP_NAME.app not found inside zip"

# 5. Install to /Applications
say "Installing to /Applications"
if [[ -d "/Applications/$APP_NAME.app" ]]; then
  rm -rf "/Applications/$APP_NAME.app"
fi
cp -R "$APP_PATH" "/Applications/"

# 6. Remove Gatekeeper quarantine (unsigned build)
say "Clearing quarantine attributes (unsigned build)"
xattr -dr com.apple.quarantine "/Applications/$APP_NAME.app" || true

# 7. Launch
say "Done. Launching..."
open "/Applications/$APP_NAME.app"

cat <<EOF

✅ $APP_NAME 설치 완료.

처음 실행 시 macOS 보안 경고가 나오면:
  시스템 설정 → 개인정보 보호 및 보안 → "확인 없이 열기" 클릭

문제가 있으면: https://github.com/$REPO/issues
EOF

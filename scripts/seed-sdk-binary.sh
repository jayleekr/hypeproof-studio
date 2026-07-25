#!/usr/bin/env bash
# seed-sdk-binary.sh — instructor pre-seed of the Claude Agent SDK native
# `claude` binary for venue machines (#282 W4a, docs/sdk-bundling.md §5).
#
# Downloads the platform tarball DIRECTLY from the npm registry (no npm/node
# required on the target machine), verifies its sha512 against the pinned
# manifest, extracts the `claude` binary to the per-user seeded location the
# Studio extension resolves (sdkCoachHelpers.seededSdkBinaryPath), marks it
# executable, and writes the `.verified.json` integrity marker the runtime
# trusts (full sha512 runs ONCE here; the extension checks marker + size).
#
# Seeded locations (must stay in lockstep with seededSdkBinaryPath):
#   darwin — ~/Library/Application Support/HypeProof-Studio/sdk/<version>/claude
#   linux  — ${XDG_CONFIG_HOME:-~/.config}/HypeProof-Studio/sdk/<version>/claude
#   win32  — %APPDATA%\HypeProof-Studio\sdk\<version>\claude.exe
#            (handled by the PowerShell companion scripts/seed-sdk-binary.ps1,
#            which mirrors this script for win32-x64 / win32-arm64. #426)
#
# Usage:
#   bash scripts/seed-sdk-binary.sh                    # networked venue machine
#   bash scripts/seed-sdk-binary.sh --tarball /Volumes/USB/claude-agent-sdk-darwin-arm64-0.3.207.tgz
#   bash scripts/seed-sdk-binary.sh --force            # re-seed over an existing install
#   bash scripts/seed-sdk-binary.sh --version 0.3.207  # explicit version (non-pinned → registry integrity)
#
# Idempotent: an already-seeded binary with a valid marker exits 0 untouched.
# Written to be zsh-compatible (no bash-only idioms beyond the bash shebang).

set -euo pipefail

# ── Pinned manifest ──────────────────────────────────────────────────────────
# Single source of truth is extensions/hypeproof-chat/src/sdkBinaryManifest.ts
# (itself locked to package-lock.json). test/sdk-binary.smoke.mjs fails if the
# values below drift from that manifest — bump both together with the SDK dep.
PINNED_VERSION="0.3.207"

pinned_sha512() {
  case "$1" in
    darwin-arm64) printf '%s' "sha512-08xSo1FDx8h0aLhL5tvcRxa2SMmcUV3aDWeZiEJVTclyiDAs61BgTjAxCg+SZcu1CndjJO8cfO0yM5dhamxz3g==" ;;
    darwin-x64)   printf '%s' "sha512-1o7K4EYqyCixZ/oeOZSh7AzSy6TM86xoOuf4VuORjPSS31hBnoqY0NGZd27+2VDs9LGtsdksmsTqcNGx9xd1hA==" ;;
    win32-x64)    printf '%s' "sha512-YPjVT0q6aXEM2MgN4CI6/9fqiTXwETji+4NoPOzCYuqAkhXZqp30Jsk7/NHqYGNNSfURKrsuAoliKB0rsbpbjg==" ;;
    win32-arm64)  printf '%s' "sha512-9fWpUzfkXlPAg2tf8JpQe7w9avFaomAUbfAwyAmykQgSIf66LwaJjvI5hNqhNqczRKyfsXPn3ei2S5HKlmFP+Q==" ;;
    linux-x64)    printf '%s' "sha512-Kg6BPH8Ee0ny/oEUWJmvT1jCRBne4jVpRSOMsJcYp1Fav1rMEgpU219oJJs+LWwx4ifuuLtNWedqJNnVw7mnKg==" ;;
    linux-arm64)  printf '%s' "sha512-X4uezYOifDiNTTmmugfRCdg3nNamrr1LFRY9hg30vWYTShL+bbN+nfC3KaFfSYCl4GTtsEEUbYdOTC2F3bBpcA==" ;;
    *)            printf '%s' "" ;;
  esac
}

say() { printf "\n\033[1;35m▶ %s\033[0m\n" "$*"; }
err() { printf "\033[1;31mERROR:\033[0m %s\n" "$*" >&2; exit 1; }

# ── Args ─────────────────────────────────────────────────────────────────────
VERSION=""
TARBALL=""
PLATFORM=""
FORCE="no"
while [ $# -gt 0 ]; do
  case "$1" in
    --version)  VERSION="${2:?--version needs a value}"; shift 2 ;;
    --tarball)  TARBALL="${2:?--tarball needs a path}"; shift 2 ;;
    --platform) PLATFORM="${2:?--platform needs a value (e.g. darwin-arm64)}"; shift 2 ;;
    --force)    FORCE="yes"; shift ;;
    -h|--help)  sed -n '2,30p' "$0"; exit 0 ;;
    *) err "Unknown argument: $1 (see --help)" ;;
  esac
done

# ── Platform detection (darwin-arm64 is the first-class target) ─────────────
if [ -z "$PLATFORM" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)          PLATFORM="darwin-arm64" ;;
    Darwin-x86_64)         PLATFORM="darwin-x64" ;;
    Linux-x86_64)          PLATFORM="linux-x64" ;;
    Linux-aarch64|Linux-arm64) PLATFORM="linux-arm64" ;;
    *) err "Unsupported platform $(uname -s)/$(uname -m) — pass --platform explicitly" ;;
  esac
fi
case "$PLATFORM" in
  win32-*) err "win32 seeding lives in the PowerShell companion — run scripts/seed-sdk-binary.ps1 (#426)" ;;
esac

# ── Version resolution: pinned by default, cross-checked against the repo ───
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCKFILE="$SCRIPT_DIR/../extensions/hypeproof-chat/package-lock.json"
if [ -z "$VERSION" ]; then
  VERSION="$PINNED_VERSION"
  # Drift guard when run from the repo: the extension lockfile is the ultimate
  # pin for the SDK dependency (package.json carries a ^range; the lockfile
  # resolves it exactly). Fails loudly instead of seeding a mismatched binary.
  if [ -f "$LOCKFILE" ]; then
    LOCK_VERSION="$(sed -n 's|.*claude-agent-sdk/-/claude-agent-sdk-\([0-9][0-9.]*\)\.tgz.*|\1|p' "$LOCKFILE" | head -n1)"
    if [ -n "$LOCK_VERSION" ] && [ "$LOCK_VERSION" != "$VERSION" ]; then
      err "Pinned version $VERSION disagrees with extension package-lock.json ($LOCK_VERSION). Update PINNED_VERSION + sha512 table (and sdkBinaryManifest.ts) together with the dependency."
    fi
  fi
fi

# ── Expected integrity ───────────────────────────────────────────────────────
PKG="@anthropic-ai/claude-agent-sdk-$PLATFORM"
TGZ_URL="https://registry.npmjs.org/$PKG/-/claude-agent-sdk-$PLATFORM-$VERSION.tgz"
if [ "$VERSION" = "$PINNED_VERSION" ]; then
  EXPECTED_SHA="$(pinned_sha512 "$PLATFORM")"
  [ -n "$EXPECTED_SHA" ] || err "No pinned sha512 for platform $PLATFORM"
else
  say "Non-pinned version $VERSION — fetching dist.integrity from the npm registry"
  EXPECTED_SHA="$(curl -fsSL "https://registry.npmjs.org/$PKG/$VERSION" \
    | sed -n 's|.*"integrity":"\(sha512-[^"]*\)".*|\1|p' | head -n1)"
  [ -n "$EXPECTED_SHA" ] || err "Could not read dist.integrity for $PKG@$VERSION from the registry"
fi

# ── Destination (keep in lockstep with seededSdkBinaryPath) ──────────────────
case "$PLATFORM" in
  darwin-*) DEST_DIR="$HOME/Library/Application Support/HypeProof-Studio/sdk/$VERSION" ;;
  linux-*)  DEST_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/HypeProof-Studio/sdk/$VERSION" ;;
esac
DEST_BIN="$DEST_DIR/claude"
MARKER="$DEST_BIN.verified.json"

# ── Idempotency: a valid existing seed is left untouched ─────────────────────
if [ "$FORCE" != "yes" ] && [ -x "$DEST_BIN" ] && [ -f "$MARKER" ]; then
  CUR_SIZE="$(wc -c < "$DEST_BIN" | tr -d ' ')"
  if grep -q "\"sdkVersion\": \"$VERSION\"" "$MARKER" && grep -q "\"size\": $CUR_SIZE" "$MARKER"; then
    say "Already seeded and verified — nothing to do"
    printf '  binary : %s\n  size   : %s bytes\n  marker : %s\n' "$DEST_BIN" "$CUR_SIZE" "$MARKER"
    exit 0
  fi
  say "Existing seed at $DEST_BIN failed the marker/size check — re-seeding"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── Obtain the tarball ───────────────────────────────────────────────────────
if [ -n "$TARBALL" ]; then
  [ -f "$TARBALL" ] || err "Tarball not found: $TARBALL"
  say "Using local tarball (air-gapped mode): $TARBALL"
  TGZ="$TARBALL"
else
  say "Downloading $PKG@$VERSION (~67 MiB) from the npm registry"
  TGZ="$TMP/sdk.tgz"
  curl -fL --retry 3 -o "$TGZ" "$TGZ_URL"
fi

# ── Verify sha512 (SRI base64 form, same value npm enforces) ─────────────────
say "Verifying sha512"
if command -v openssl >/dev/null 2>&1; then
  ACTUAL_SHA="sha512-$(openssl dgst -sha512 -binary "$TGZ" | base64 | tr -d '\n')"
else
  # Fallback: shasum emits hex; convert to the SRI base64 form via xxd.
  ACTUAL_SHA="sha512-$(shasum -a 512 "$TGZ" | cut -d' ' -f1 | xxd -r -p | base64 | tr -d '\n')"
fi
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  err "sha512 mismatch for $TGZ
  expected: $EXPECTED_SHA
  actual:   $ACTUAL_SHA
Refusing to install. (Corrupt download? Wrong --version/--tarball?)"
fi
printf '  ok: %s\n' "$ACTUAL_SHA"

# ── Extract + install atomically ─────────────────────────────────────────────
say "Extracting package/claude"
tar -xzf "$TGZ" -C "$TMP" package/claude
[ -f "$TMP/package/claude" ] || err "Tarball did not contain package/claude"
mkdir -p "$DEST_DIR"
chmod 755 "$TMP/package/claude"
BIN_SIZE="$(wc -c < "$TMP/package/claude" | tr -d ' ')"
mv -f "$TMP/package/claude" "$DEST_BIN"

# ── Write the runtime-trusted marker (see sdkBinaryManifest.ts trust model) ──
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$MARKER" <<EOF
{
  "sdkVersion": "$VERSION",
  "size": $BIN_SIZE,
  "tarballSha512": "$EXPECTED_SHA",
  "verifiedAt": "$NOW",
  "seededBy": "scripts/seed-sdk-binary.sh"
}
EOF

# ── Verification printout ────────────────────────────────────────────────────
say "Seeded successfully"
printf '  binary : %s\n' "$DEST_BIN"
printf '  size   : %s bytes\n' "$BIN_SIZE"
printf '  sha512 : %s (tarball, verified)\n' "$ACTUAL_SHA"
printf '  marker : %s\n' "$MARKER"
if "$DEST_BIN" --version >/dev/null 2>&1; then
  printf '  launch : %s\n' "$("$DEST_BIN" --version 2>/dev/null | head -n1)"
else
  printf '  launch : (skipped — binary did not answer --version here; Studio will still verify at runtime)\n'
fi

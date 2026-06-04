#!/usr/bin/env bash
# Phase 0 decision gate — verify all prerequisites before first build.
# Exit code 0 = ready. Non-zero = at least one check failed.

set -u

PASS=0
FAIL=0

check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf "  \033[32m✓\033[0m %s\n" "$label"
    PASS=$((PASS+1))
  else
    printf "  \033[31m✗\033[0m %s\n" "$label"
    FAIL=$((FAIL+1))
  fi
}

check_version() {
  local label="$1" cmd="$2" expected="$3"
  local actual
  actual="$("$cmd" --version 2>/dev/null | head -1 || true)"
  if [[ "$actual" == *"$expected"* ]]; then
    printf "  \033[32m✓\033[0m %s (%s)\n" "$label" "$actual"
    PASS=$((PASS+1))
  else
    printf "  \033[31m✗\033[0m %s — got: %s, expected: %s\n" "$label" "${actual:-(missing)}" "$expected"
    FAIL=$((FAIL+1))
  fi
}

echo "HypeProof Studio — environment check"
echo

echo "Toolchain:"
check_version "Node.js 22.22.1"  node          "v22.22.1"
check_version "Python 3.11"      python3.11    "Python 3.11"
check        "rustup installed"  command -v rustup
check        "cargo"             command -v cargo
check        "rustc"             command -v rustc
check        "Xcode CLI tools"   xcode-select -p
check        "Homebrew"          command -v brew
check        "jq"                command -v jq
check        "gnu-sed (gsed)"    command -v gsed
check        "libicns (icns2png)" command -v icns2png
check        "icoutils (icotool)" command -v icotool
check        "imagemagick (composite)" command -v composite
check        "librsvg (rsvg-convert)" command -v rsvg-convert

echo
echo "Disk space (/ needs >= 60 GB free for build + artifacts):"
AVAIL_GB=$(df -g / | awk 'NR==2 {print $4}')
if [[ "${AVAIL_GB:-0}" -ge 60 ]]; then
  printf "  \033[32m✓\033[0m %s GB free\n" "$AVAIL_GB"
  PASS=$((PASS+1))
else
  printf "  \033[31m✗\033[0m only %s GB free, need >= 60\n" "$AVAIL_GB"
  FAIL=$((FAIL+1))
fi

echo
echo "Memory (build needs NODE_OPTIONS max-old-space-size >= 12 GB):"
TOTAL_GB=$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))
if [[ "$TOTAL_GB" -ge 16 ]]; then
  printf "  \033[32m✓\033[0m %s GB RAM\n" "$TOTAL_GB"
  PASS=$((PASS+1))
else
  printf "  \033[33m!\033[0m only %s GB RAM — build may swap heavily\n" "$TOTAL_GB"
fi

echo
echo "Architecture:"
ARCH=$(uname -m)
if [[ "$ARCH" == "arm64" ]]; then
  printf "  \033[32m✓\033[0m %s (Apple Silicon)\n" "$ARCH"
  PASS=$((PASS+1))
else
  printf "  \033[33m!\033[0m %s — build target is darwin-arm64; cross-build path untested\n" "$ARCH"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  echo
  echo "Install hints (run as needed):"
  echo "  brew install nvm jq gnu-sed libicns icoutils imagemagick librsvg python@3.11"
  echo "  nvm install 22.22.1 && nvm alias default 22.22.1"
  echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  echo "  xcode-select --install"
  exit 1
fi
echo "Ready to proceed to Phase 1."

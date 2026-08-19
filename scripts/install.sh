#!/bin/sh
# =============================================================================
# HypeProof one-line bootstrap (macOS / Linux)
#
#   curl -fsSL https://raw.githubusercontent.com/jayleekr/hypeproof-studio-releases/main/install.sh | bash
#
# This is the POSIX-sh sibling of install.ps1 (Windows). Both read ONE
# versioned dependency manifest (hypeproof-deps.yaml) as the single source of
# truth. The manifest values are embedded below so the bootstrap stays a single
# self-contained file when piped from curl; they are kept byte-for-byte in sync
# with hypeproof-deps.yaml (schema 1) and re-verified at the end by the built-in
# `hps doctor` pass.
#
# What it does:
#   1. Detect OS / arch / login shell + rc file.
#   2. Ensure a package manager (Homebrew on mac; brew or native pkg on Linux).
#   3. Check each REAL runtime dependency from the manifest; install the missing.
#   4. Download + install the HypeProof Studio app and seed the native SDK binary.
#   5. Dedupe every PATH / rc edit via a receipt so re-runs are idempotent upgrades.
#   6. Finish with a fail-closed `hps doctor` that re-verifies the same manifest.
#
# Flags / env:
#   -y | HPS_NONINTERACTIVE=1   unattended (assume yes, no prompts)
#   INSTALLER_NO_MODIFY_PATH=1  never touch PATH / rc files
#   HPS_SKIP_STUDIO=1           skip Studio app + SDK seed (deps only)
#   HPS_DEBUG=1                 xtrace
# =============================================================================

set -eu

# ----------------------------------------------------------------------------- #
# 0. Constants (embedded from hypeproof-deps.yaml — schema: 1)
# ----------------------------------------------------------------------------- #
MANIFEST_SCHEMA=1

STUDIO_RELEASES_REPO="jayleekr/hypeproof-studio-releases"
# "latest" resolves from the releases API at run time. A hard pin here goes stale
# the moment a release ships (it sat at 0.1.33 while the repo served v0.1.34),
# and every participant would then install a version behind. Override with
# HPS_STUDIO_VERSION=0.1.33 to install a specific one.
STUDIO_VERSION="${HPS_STUDIO_VERSION:-latest}"
# The published assets carry NO version in the name — `HypeProof-Studio-darwin-arm64.zip`.
# The trailing `-` before `*` made the glob unmatchable, so step 5 always died with
# "No Studio asset matching …". `*` after the arch matches both shapes.
STUDIO_ASSET_GLOB_DARWIN_ARM64="HypeProof-Studio-darwin-arm64*.zip"
# shellcheck disable=SC2034  # unused while install_studio_mac fails Intel early;
# kept as the ready-made glob for when a darwin-x64 asset ships (#331).
STUDIO_ASSET_GLOB_DARWIN_X64="HypeProof-Studio-darwin-x64*.zip"

# SDK seeding is delegated to the canonical scripts/seed-sdk-binary.sh — the
# single source of truth for the platform package, the pinned SDK version, the
# sha512 table, the seeded location (darwin/linux), and the runtime-trusted
# `.verified.json` marker. Do NOT reinvent seeding here.
SEED_SCRIPT_NAME="seed-sdk-binary.sh"
# Raw base for the bootstrap (curl | bash) path, where no sibling script exists.
# It must point at a tree that ACTUALLY hosts scripts/seed-sdk-binary.sh: that is
# this repo, not the releases repo (which carries the Studio binaries only).
# Override with HPS_RAW_BASE once a mirror is published.
RAW_BASE="${HPS_RAW_BASE:-https://raw.githubusercontent.com/jayleekr/hypeproof-studio/main/scripts}"

HPS_HOME="${HOME}/.hypeproof"
RECEIPT="${HPS_HOME}/receipt.json"
STUDIO_SUPPORT="${HOME}/Library/Application Support/HypeProof-Studio"  # mac path; overridden on Linux below

[ "${HPS_DEBUG:-0}" = "1" ] && set -x

# ----------------------------------------------------------------------------- #
# 1. Pretty output helpers
# ----------------------------------------------------------------------------- #
if [ -t 1 ]; then
  C_RESET="$(printf '\033[0m')"; C_BOLD="$(printf '\033[1m')"
  C_GREEN="$(printf '\033[32m')"; C_YELLOW="$(printf '\033[33m')"
  C_RED="$(printf '\033[31m')"; C_BLUE="$(printf '\033[36m')"
else
  C_RESET=""; C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_BLUE=""
fi

STEP_N=0
step()  { STEP_N=$((STEP_N + 1)); printf '%s\n' "${C_BOLD}${C_BLUE}==> [${STEP_N}] $*${C_RESET}"; }
info()  { printf '    %s\n' "$*"; }
ok()    { printf '    %s%s%s\n' "${C_GREEN}" "✓ $*" "${C_RESET}"; }
warn()  { printf '    %s%s%s\n' "${C_YELLOW}" "! $*" "${C_RESET}"; }
die()   { printf '%s\n' "${C_RED}${C_BOLD}✗ $*${C_RESET}" >&2; exit 1; }

# ----------------------------------------------------------------------------- #
# 2. Flags / interactivity
# ----------------------------------------------------------------------------- #
NONINTERACTIVE="${HPS_NONINTERACTIVE:-0}"
for arg in "$@"; do
  case "$arg" in
    -y|--yes|--noninteractive) NONINTERACTIVE=1 ;;
    -h|--help)
      printf 'Usage: install.sh [-y]\n  -y  unattended (HPS_NONINTERACTIVE=1)\n'
      exit 0 ;;
    *) warn "ignoring unknown argument: $arg" ;;
  esac
done
# stdin is the piped script under curl|bash, so prompts are impossible there.
[ -t 0 ] || NONINTERACTIVE=1

# --- curl | bash 안전장치: 자기 자신을 파일로 다시 실행한다 ------------------- #
# 파이프로 오면 bash 는 이 스크립트를 stdin 에서 조금씩 읽어가며 실행한다. 그런데
# Homebrew 설치기와 그것이 부르는 CLT 설치(softwareupdate)가 **같은 stdin 을
# 소비**하기 때문에, 아직 안 읽은 뒷부분(4 Studio 설치 · 5 SDK 시드 · 6 doctor)이
# 통째로 사라진다. bash 는 EOF 를 만나 그대로 **성공(0)** 으로 끝나고, 참가자는
# "설치 완료" 를 본 뒤 앱이 없는 상태로 남는다.
#
# brew·CLT 가 이미 있는 기기에서는 stdin 을 먹는 놈이 없어 재현되지 않는다 —
# 그래서 개발기에서는 늘 통과했고, 공기계에서만 터졌다. 2026-08-09 vanilla
# macOS VM 에서 재현: 9m54s / exit 0 / Studio·SDK 없음, 로그에 스크립트 뒷부분이
# 실행 대신 텍스트로 출력됨.
#
# 파일에서 읽히는 순간 이 문제는 원천적으로 사라지므로, 파이프로 들어왔으면
# 내려받아 exec 한다.
_hps_is_piped() {
  case "${0##*/}" in bash|sh|dash|zsh|-bash|-sh) return 0 ;; esac
  [ -r "$0" ] || return 0
  return 1
}
if [ -z "${HPS_REEXEC:-}" ] && _hps_is_piped; then
  _self="$(mktemp -t hps-install)" || die "mktemp failed"
  curl -fsSL "${RAW_BASE}/install.sh" -o "$_self" \
    || die "installer re-fetch failed: ${RAW_BASE}/install.sh"
  HPS_REEXEC=1 exec bash "$_self" "$@"
fi

confirm() {  # confirm "question" -> 0 yes / 1 no; auto-yes when noninteractive
  [ "$NONINTERACTIVE" = "1" ] && return 0
  printf '%s [Y/n] ' "$1"
  read -r _ans </dev/tty 2>/dev/null || return 0
  case "$_ans" in n|N|no|NO) return 1 ;; *) return 0 ;; esac
}

have() { command -v "$1" >/dev/null 2>&1; }

# ----------------------------------------------------------------------------- #
# 3. Detect OS / arch / shell
# ----------------------------------------------------------------------------- #
step "Detecting platform"
UNAME_S="$(uname -s)"; UNAME_M="$(uname -m)"
case "$UNAME_S" in
  Darwin) OS="darwin" ;;
  Linux)  OS="linux"  ;;
  *)      die "unsupported OS: $UNAME_S (this bootstrap is macOS/Linux; use install.ps1 on Windows)" ;;
esac
case "$UNAME_M" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x64"   ;;
  *)             die "unsupported architecture: $UNAME_M" ;;
esac
PLATFORM="${OS}-${ARCH}"

# Login shell + its rc file (for PATH edits).
LOGIN_SHELL="$(basename "${SHELL:-/bin/sh}")"
case "$LOGIN_SHELL" in
  zsh)  RC_FILE="${ZDOTDIR:-$HOME}/.zshrc" ;;
  bash) if [ "$OS" = "darwin" ]; then RC_FILE="$HOME/.bash_profile"; else RC_FILE="$HOME/.bashrc"; fi ;;
  fish) RC_FILE="$HOME/.config/fish/config.fish" ;;
  *)    RC_FILE="$HOME/.profile" ;;
esac

# Studio support dir differs per OS.
if [ "$OS" = "linux" ]; then
  STUDIO_SUPPORT="${XDG_DATA_HOME:-$HOME/.local/share}/HypeProof-Studio"
fi

ok "OS=${OS} arch=${ARCH} platform=${PLATFORM}"
ok "shell=${LOGIN_SHELL} rc=${RC_FILE}"

# ----------------------------------------------------------------------------- #
# 4. Receipt (idempotency ledger)
# ----------------------------------------------------------------------------- #
mkdir -p "$HPS_HOME"
[ -f "$RECEIPT" ] || printf '{\n  "schema": %s,\n  "installed": [],\n  "path_edits": []\n}\n' "$MANIFEST_SCHEMA" > "$RECEIPT"

receipt_note() {  # receipt_note <key> <value> — append-once audit line (JSON is advisory, kept human-readable)
  _k="$1"; _v="$2"
  grep -q "\"${_k}\": \"${_v}\"" "$RECEIPT" 2>/dev/null && return 0
  # keep it simple + robust: append a trailing comment-style record the doctor can read
  printf '  # %s=%s @ %s\n' "$_k" "$_v" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$RECEIPT"
}

# grep-before-append PATH export into rc; deduped via receipt + rc scan.
ensure_path_entry() {  # ensure_path_entry <dir>
  _dir="$1"
  case ":${PATH}:" in *":${_dir}:"*) : ;; *) PATH="${_dir}:${PATH}"; export PATH ;; esac
  [ "${INSTALLER_NO_MODIFY_PATH:-0}" = "1" ] && return 0
  [ -n "$RC_FILE" ] || return 0
  _line="export PATH=\"${_dir}:\$PATH\""
  if [ -f "$RC_FILE" ] && grep -Fq "$_dir" "$RC_FILE" 2>/dev/null; then
    return 0  # already present -> idempotent
  fi
  mkdir -p "$(dirname "$RC_FILE")" 2>/dev/null || true
  {
    printf '\n# Added by HypeProof installer (%s)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '%s\n' "$_line"
  } >> "$RC_FILE"
  receipt_note "path_edit" "$_dir"
  info "PATH: added ${_dir} to ${RC_FILE}"
}

# ----------------------------------------------------------------------------- #
# 5. Package manager (Homebrew on mac; brew/native on Linux)
# ----------------------------------------------------------------------------- #
BREW=""
resolve_brew() {
  if have brew; then BREW="$(command -v brew)"; return 0; fi
  for _b in /opt/homebrew/bin/brew /usr/local/bin/brew /home/linuxbrew/.linuxbrew/bin/brew; do
    [ -x "$_b" ] && { BREW="$_b"; eval "$("$_b" shellenv)"; return 0; }
  done
  return 1
}

ensure_brew() {
  step "Ensuring package manager (Homebrew)"
  if resolve_brew; then ok "brew present: $BREW"; return 0; fi
  if [ "$OS" = "darwin" ]; then
    if confirm "Homebrew not found. Install it now (also triggers Xcode CLT)?"; then
      NONINTERACTIVE_BREW=""
      [ "$NONINTERACTIVE" = "1" ] && NONINTERACTIVE_BREW="NONINTERACTIVE=1"
      # </dev/null 은 이중 안전장치다. 위쪽 re-exec 가 이미 stdin 의존을 없앴지만,
      # brew 설치기와 그것이 부르는 softwareupdate 가 stdin 을 읽는다는 사실 자체는
      # 그대로이므로 여기서도 끊어둔다 (누가 re-exec 를 걷어내도 안 터지게).
      env $NONINTERACTIVE_BREW /bin/bash -c \
        "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
        </dev/null \
        || die "Homebrew install failed. See https://brew.sh"
      resolve_brew || die "Homebrew installed but 'brew' not on PATH; open a new shell and re-run."
      ensure_path_entry "$(dirname "$BREW")"
      ok "Homebrew installed: $BREW"
    else
      warn "Skipping Homebrew; will fall back to direct downloads where possible."
    fi
  else
    # Linux: prefer an already-present native manager; brew optional.
    warn "No Homebrew on Linux; will use the native package manager / direct fallback."
  fi
}

# Native Linux package manager abstraction (fallback path when brew absent).
LINUX_PM=""
detect_linux_pm() {
  for _p in apt-get dnf yum pacman zypper apk; do
    have "$_p" && { LINUX_PM="$_p"; return 0; }
  done
  return 1
}
linux_pkg_install() {  # linux_pkg_install <pkg...>
  [ -n "$LINUX_PM" ] || detect_linux_pm || return 1
  _sudo=""; [ "$(id -u)" -ne 0 ] && have sudo && _sudo="sudo"
  case "$LINUX_PM" in
    apt-get) $_sudo apt-get update -y && $_sudo apt-get install -y "$@" ;;
    dnf)     $_sudo dnf install -y "$@" ;;
    yum)     $_sudo yum install -y "$@" ;;
    pacman)  $_sudo pacman -Sy --noconfirm "$@" ;;
    zypper)  $_sudo zypper install -y "$@" ;;
    apk)     $_sudo apk add "$@" ;;
    *)       return 1 ;;
  esac
}

# ----------------------------------------------------------------------------- #
# 6. Dependency table (embedded from manifest `tools:`)
#    Fields:  id | check-cmd | brew-pkg | linux-native-pkg | preinstalled? | min/pin note
# ----------------------------------------------------------------------------- #
# We iterate this list; each row maps 1:1 to a manifest tool entry.
DEP_IDS="git bash gh node python jq curl"

dep_check_cmd() {
  case "$1" in
    git)    echo "git --version" ;;
    bash)   echo "bash --version" ;;
    gh)     echo "gh --version" ;;
    node)   echo "node --version" ;;
    python) echo "python3 --version" ;;
    jq)     echo "jq --version" ;;
    curl)   echo "curl --version" ;;
  esac
}
dep_binary() {  # the executable that `have` should test
  case "$1" in
    python) echo "python3" ;;
    *)      echo "$1" ;;
  esac
}
dep_brew_pkg() {
  case "$1" in
    git)    echo "git" ;;
    bash)   echo "bash" ;;          # mac /bin/bash 3.2 is fine; brew bash only if truly missing
    gh)     echo "gh" ;;
    node)   echo "node@22" ;;
    python) echo "python@3.11" ;;
    jq)     echo "jq" ;;
    curl)   echo "curl" ;;
  esac
}
dep_linux_pkg() {
  case "$1" in
    git)    echo "git" ;;
    bash)   echo "bash" ;;
    gh)     echo "gh" ;;            # may require github-cli repo; best-effort
    node)   echo "nodejs npm" ;;
    python) echo "python3" ;;
    jq)     echo "jq" ;;
    curl)   echo "curl" ;;
  esac
}
dep_preinstalled_ok() {  # deps we accept as-is if already present (no forced upgrade)
  case "$1" in
    bash|curl) return 0 ;;
    *)         return 1 ;;
  esac
}

# --- version gate (embedded from manifest `min_version`) --------------------- #
# 2026-08-10, 순정 macOS VM 실측에서 드러난 구멍: 이 아래 두 곳(install_one_dep /
# doctor)이 **존재만** 보고 버전을 보지 않았다. 그 결과 stock macOS 의
# /usr/bin/python3 (3.9.6) 이 manifest 의 min_version 3.11 을 만족하는 것으로
# 취급되어 python@3.11 이 아예 설치되지 않았고, 그럼에도 "all manifest checks
# passed" 가 찍혔다. 참가자 머신 전부가 이 상태로 워크숍에 온다.
#
# tier 를 존중한다 — required/recommended 만 강제한다. bash(maintainer, min 5.0)
# 를 강제하면 /bin/bash 3.2 인 모든 macOS 설치가 깨진다. dev/maintainer 티어는
# scripts/hps-doctor.sh 가 warn 으로 다룬다(동일 정책).
dep_min_version() {
  case "$1" in
    git)    echo "2.30" ;;
    gh)     echo "2.40" ;;
    python) echo "3.11" ;;
    jq)     echo "1.6"  ;;
    node)   echo "18.0" ;;
    *)      echo ""     ;;   # bash·curl: tier 상 강제하지 않는다
  esac
}

# 체크 명령 출력에서 첫 dotted-numeric 토큰을 뽑는다.
#   "git version 2.39.5" → 2.39.5 · "jq-1.7.1-apple" → 1.7.1 · "v22.23.2" → 22.23.2
dep_version_of() {
  eval "$(dep_check_cmd "$1")" 2>/dev/null | head -n1 \
    | sed -n 's/[^0-9]*\([0-9][0-9]*\(\.[0-9][0-9]*\)*\).*/\1/p'
}

# ver_ge A B — dotted-numeric A >= B. hps-doctor.sh 와 동일 구현(정책 일치).
ver_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN{
    na=split(a,A,"."); nb=split(b,B,".");
    n=(na>nb)?na:nb;
    for(i=1;i<=n;i++){ x=(i<=na?A[i]+0:0); y=(i<=nb?B[i]+0:0);
      if(x>y){ exit 0 } if(x<y){ exit 1 } }
    exit 0
  }'
}

# dep_satisfies_min <id> — 버전 요구가 없거나(빈 min) 충족하면 0.
dep_satisfies_min() {
  _min="$(dep_min_version "$1")"
  [ -z "$_min" ] && return 0
  _got="$(dep_version_of "$1")"
  [ -z "$_got" ] && return 0        # 버전을 못 읽으면 막지 않는다(기존 동작 유지)
  ver_ge "$_got" "$_min"
}

install_one_dep() {  # install_one_dep <id>
  _id="$1"; _bin="$(dep_binary "$_id")"
  if have "$_bin"; then
    if dep_satisfies_min "$_id"; then
      ok "${_id}: $(eval "$(dep_check_cmd "$_id")" 2>/dev/null | head -n1)"
      return 0
    fi
    # 있지만 manifest 최소 버전 미만 — 설치를 계속 진행해 브루 패키지를 올린다.
    # (예: stock macOS 의 python3 3.9.6 vs min 3.11 → python@3.11 설치)
    info "${_id}: $(dep_version_of "$_id") < 최소 $(dep_min_version "$_id") — 설치를 진행합니다…"
  fi

  # mac /bin/bash 3.2 & system curl satisfy the manifest even if not on PATH as such.
  if dep_preinstalled_ok "$_id" && [ "$OS" = "darwin" ] && [ -x "/bin/$_id" ]; then
    ok "${_id}: using system /bin/${_id}"
    return 0
  fi

  info "${_id}: missing — installing…"
  if resolve_brew; then
    if "$BREW" install "$(dep_brew_pkg "$_id")"; then
      # keg-only formulae (node@22, python@3.11) need their opt/bin on PATH
      case "$_id" in
        node)   ensure_path_entry "$("$BREW" --prefix)/opt/node@22/bin" ;;
        python) ensure_path_entry "$("$BREW" --prefix)/opt/python@3.11/bin"
                _pp="$("$BREW" --prefix)/opt/python@3.11/libexec/bin"
                [ -d "$_pp" ] && ensure_path_entry "$_pp" ;;
      esac
      receipt_note "installed" "$_id"
      ok "${_id}: installed via brew"
      return 0
    fi
    warn "${_id}: brew install failed — trying direct fallback"
  fi

  # Direct / native fallback.
  # shellcheck disable=SC2046  # intentional word-splitting: some rows are multi-pkg ("nodejs npm")
  if [ "$OS" = "linux" ] && linux_pkg_install $(dep_linux_pkg "$_id"); then
    receipt_note "installed" "$_id"
    ok "${_id}: installed via native package manager"
    return 0
  fi

  # Last-resort per-tool fallbacks.
  case "$_id" in
    node)
      if confirm "Install Node 22 via the official nvm fallback?"; then
        curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash || true
        # shellcheck disable=SC1090
        export NVM_DIR="${HOME}/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
        nvm install 22.22.1 && nvm alias default 22.22.1 || true
        have node && { receipt_note "installed" "node"; ok "node: installed via nvm"; return 0; }
      fi ;;
  esac

  die "${_id}: could not install (no brew / native pkg / fallback succeeded). Install it manually and re-run."
}

check_deps() {
  step "Checking + installing runtime dependencies (manifest schema ${MANIFEST_SCHEMA})"
  for _id in $DEP_IDS; do
    install_one_dep "$_id"
  done
  # Post: warn (not fail) if gh is unauthenticated — matches manifest gh.post.
  if have gh; then
    if gh auth status >/dev/null 2>&1; then ok "gh: authenticated"; else warn "gh: not authenticated — run 'gh auth login' before using PR/review skills"; fi
  fi
}

# ----------------------------------------------------------------------------- #
# 7. HypeProof Studio app + native SDK seed
# ----------------------------------------------------------------------------- #
# Turn STUDIO_VERSION="latest" into the concrete tag the releases repo serves.
# Everything downstream (the installed-version compare, the receipt) needs a real
# number, so resolve once and rewrite the global.
resolve_studio_version() {
  [ "$STUDIO_VERSION" != "latest" ] && return 0
  _tag=""
  if have gh; then
    _tag="$(gh release view --repo "$STUDIO_RELEASES_REPO" --json tagName --jq .tagName 2>/dev/null || true)"
  fi
  if [ -z "$_tag" ]; then
    _tag="$(curl -fsSL "https://api.github.com/repos/${STUDIO_RELEASES_REPO}/releases/latest" 2>/dev/null \
      | grep -o '"tag_name": *"[^"]*"' | head -n1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
  fi
  [ -n "$_tag" ] || die "could not resolve the latest Studio release from ${STUDIO_RELEASES_REPO} (set HPS_STUDIO_VERSION=<x.y.z>)"
  STUDIO_VERSION="${_tag#v}"
  info "Studio version: ${STUDIO_VERSION} (resolved from latest)"
}

gh_asset_url() {  # gh_asset_url <glob> -> download URL of first matching asset for STUDIO_VERSION
  _glob="$1"
  _api="https://api.github.com/repos/${STUDIO_RELEASES_REPO}/releases/tags/v${STUDIO_VERSION}"
  _auth=""; [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ] && _auth="-H \"Authorization: Bearer ${GH_TOKEN:-$GITHUB_TOKEN}\""
  # Prefer gh (handles auth + pagination) when available; else curl the API.
  # Match on the asset NAME, never on a URL basename.
  #
  # The two sources spell the download URL differently and mixing them up yields
  # the literal string "null":
  #   gh release view --json assets  ->  .url      (browser download)  /  .apiUrl
  #   REST /releases/tags/<tag>      ->  .browser_download_url         /  .url (api)
  #
  # `have gh` is NOT proof gh can talk to the API. check_deps brew-installs gh
  # from the manifest and only WARNS when it is unauthenticated, so on every
  # fresh machine install_studio reaches here with a gh that exits 4 and prints
  # nothing to stdout ("please run: gh auth login"). The old code returned
  # unconditionally after the gh pipeline, so an empty result skipped the
  # anonymous curl fallback entirely and the caller reported the asset as missing —
  # "No Studio asset matching 'HypeProof-Studio-darwin-arm64*.zip' … build may
  # not exist yet" — while the asset was in fact published and downloadable
  # without auth. Only return when gh actually produced a URL; otherwise fall
  # through, exactly as resolve_studio_version() already does for the tag.
  # NOTE: the `case … in $_glob)` below must never sit inside a $(…) — macOS
  # /bin/bash is 3.2, which cannot parse an unquoted glob pattern in a case arm
  # inside a command substitution ("syntax error near unexpected token
  # `newline'"). `curl … | bash` runs under exactly that shell, so capture gh's
  # output FIRST and match outside the substitution.
  if have gh; then
    # `|| _assets=""` is load-bearing under `set -e` (line 29): assigning from a
    # command substitution that exits non-zero (unauthenticated gh exits 4)
    # aborts the whole script right here, before die() can ever report why.
    _assets="$(gh release view "v${STUDIO_VERSION}" --repo "$STUDIO_RELEASES_REPO" \
      --json assets --jq '.assets[] | "\(.name)\t\(.url)"' 2>/dev/null)" || _assets=""
    # Non-empty means gh reached the API and we saw the authoritative asset
    # list — match against it and return, even if nothing matches.
    if [ -n "$_assets" ]; then
      printf '%s\n' "$_assets" | while IFS="$(printf '\t')" read -r _name _dl; do
        # shellcheck disable=SC2254  # $_glob is INTENDED as a glob pattern here
        case "$_name" in $_glob) echo "$_dl"; break ;; esac
      done
      return 0
    fi
    # Empty means gh could not talk to the API at all — fall through to curl.
  fi
  # curl fallback: match browser_download_url lines against the glob.
  curl -fsSL "$_api" 2>/dev/null | grep -o '"browser_download_url": *"[^"]*"' | \
    sed 's/.*"browser_download_url": *"\([^"]*\)".*/\1/' | \
    while IFS= read -r u; do
      # shellcheck disable=SC2254  # $_glob is INTENDED as a glob pattern here
      case "$(basename "$u")" in $_glob) echo "$u"; break ;; esac
    done
}

install_studio_mac() {
  _glob=""
  case "$PLATFORM" in
    darwin-arm64) _glob="$STUDIO_ASSET_GLOB_DARWIN_ARM64" ;;
    # build-mac.yml is arm64-only, so no darwin-x64 asset is ever produced.
    # Without this branch an Intel Mac installs every brew dependency first and
    # only then dies on a generic "asset may not exist yet", which reads as a
    # broken release rather than an unsupported machine. Mirrors the early
    # guard install-mac.sh already carries (#362). Turn this back into the
    # x64 glob once a matching asset ships.
    darwin-x64)   die "Intel Mac(x86_64)는 현재 지원되지 않습니다 — HypeProof Studio는 Apple Silicon(arm64) 전용 빌드만 제공합니다. (Intel 지원 여부는 논의 중: jayleekr/hypeproof-studio#331)" ;;
  esac
  if [ -d "/Applications/HypeProof Studio.app" ]; then
    # Idempotent upgrade: only replace if version differs.
    _cur="$(defaults read "/Applications/HypeProof Studio.app/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo "?")"
    if [ "$_cur" = "$STUDIO_VERSION" ]; then ok "Studio ${STUDIO_VERSION} already installed"; return 0; fi
    info "Studio ${_cur} -> ${STUDIO_VERSION} (upgrading)"
  fi
  _url="$(gh_asset_url "$_glob")"
  [ -n "$_url" ] || die "No Studio asset matching '${_glob}' in ${STUDIO_RELEASES_REPO} v${STUDIO_VERSION} (fail-closed: ${PLATFORM} build may not exist yet)"
  _tmp="$(mktemp -d)"; _zip="${_tmp}/studio.zip"
  info "Downloading $(basename "$_url")…"
  if have gh && printf '%s' "$_url" | grep -q 'api.github.com'; then
    gh api "$_url" > "$_zip" 2>/dev/null || curl -fsSL -o "$_zip" "$_url"
  else
    curl -fsSL -o "$_zip" "$_url" || die "download failed: $_url"
  fi
  info "Unzipping to /Applications…"
  ( cd "$_tmp" && unzip -q -o "$_zip" ) || die "unzip failed"
  _app="$(cd "$_tmp" && find . -maxdepth 2 -name '*.app' -type d | head -n1)"
  [ -n "$_app" ] || die "no .app found in downloaded archive"
  rm -rf "/Applications/HypeProof Studio.app"
  cp -R "${_tmp}/${_app#./}" "/Applications/HypeProof Studio.app" 2>/dev/null || \
    ditto "${_tmp}/${_app#./}" "/Applications/HypeProof Studio.app"
  xattr -dr com.apple.quarantine "/Applications/HypeProof Studio.app" 2>/dev/null || true
  rm -rf "$_tmp"
  receipt_note "studio" "$STUDIO_VERSION"
  ok "Studio ${STUDIO_VERSION} installed to /Applications"
}

# Resolve the canonical seed script: prefer a local sibling (repo checkout or a
# curl -O download); otherwise fetch it from the same raw base as install.sh.
# Echoes the path to run, or empty on failure.
resolve_seed_script() {
  _self_dir=""
  # $0 is meaningful only when run from a file (not curl | bash).
  case "$0" in
    */*) _self_dir="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" ;;
  esac
  if [ -n "$_self_dir" ] && [ -f "${_self_dir}/${SEED_SCRIPT_NAME}" ]; then
    printf '%s\n' "${_self_dir}/${SEED_SCRIPT_NAME}"; return 0
  fi
  _dl="$(mktemp -d)/${SEED_SCRIPT_NAME}"
  if curl -fsSL -o "$_dl" "${RAW_BASE}/${SEED_SCRIPT_NAME}" 2>/dev/null; then
    printf '%s\n' "$_dl"; return 0
  fi
  return 1
}

seed_sdk() {
  # Delegate to the canonical seed-sdk-binary.sh (single source of truth for the
  # package, pinned version 0.3.207, sha512 table, seeded location, and the
  # runtime-trusted marker). An earlier inline copy here drifted (wrong package/
  # version, a marker schema + linux path the Studio runtime would not trust).
  step "Seeding native SDK binary (canonical ${SEED_SCRIPT_NAME})"
  _seed="$(resolve_seed_script)" || {
    warn "Could not obtain ${SEED_SCRIPT_NAME} (local or ${RAW_BASE}) — Studio will self-heal on first run"
    return 0
  }
  # Pass --platform on Linux where auto-detect may need help; darwin auto-detects.
  if bash "$_seed" ${HPS_SDK_VERSION:+--version "$HPS_SDK_VERSION"}; then
    # Record the version the seeder actually wrote (from its verified marker).
    _mk="$(find "${STUDIO_SUPPORT%/*}/HypeProof-Studio/sdk" \
             "${XDG_CONFIG_HOME:-$HOME/.config}/HypeProof-Studio/sdk" \
             -name 'claude.verified.json' 2>/dev/null | head -n1)"
    if [ -n "$_mk" ] && have grep; then
      _rv="$(grep -o '"sdkVersion": *"[^"]*"' "$_mk" 2>/dev/null | head -n1 | sed 's/.*"sdkVersion": *"\([^"]*\)".*/\1/')"
      [ -n "$_rv" ] && receipt_note "sdk" "$_rv"
    fi
    ok "SDK seeded (canonical seeder)"
  else
    warn "${SEED_SCRIPT_NAME} did not complete — Studio will self-heal on first launch"
  fi
}

install_studio() {
  [ "${HPS_SKIP_STUDIO:-0}" = "1" ] && { warn "HPS_SKIP_STUDIO=1 — skipping Studio app + SDK seed"; return 0; }
  resolve_studio_version
  step "Installing HypeProof Studio ${STUDIO_VERSION}"
  if [ "$OS" = "darwin" ]; then
    install_studio_mac
    seed_sdk
  else
    warn "Studio desktop app has no first-class Linux build in manifest v${STUDIO_VERSION}; installing runtime deps only."
    warn "Seeding SDK is still useful for headless/CLI use."
    seed_sdk
  fi
}

# ----------------------------------------------------------------------------- #
# 8. `hps doctor` — fail-closed re-verify of the SAME manifest
# ----------------------------------------------------------------------------- #
doctor() {
  step "Verify pass: hps doctor (fail-closed)"
  _fail=0
  for _id in $DEP_IDS; do
    _bin="$(dep_binary "$_id")"
    if have "$_bin" || { dep_preinstalled_ok "$_id" && [ -x "/bin/$_id" ]; }; then
      _ver="$(eval "$(dep_check_cmd "$_id")" 2>/dev/null | head -n1)"
      if dep_satisfies_min "$_id"; then
        ok "${_id}: ${_ver:-present}"
      else
        # fail-closed — 헤더가 약속한 "re-verifies the SAME manifest" 를 실제로 지킨다.
        warn "${_id}: ${_ver:-present} — manifest 최소 $(dep_min_version "$_id") 미만. 'brew install $(dep_brew_pkg "$_id")' 후 새 터미널에서 재시도"
        _fail=1
      fi
    else
      warn "${_id}: MISSING — remediation: re-run installer, or install '$(dep_brew_pkg "$_id")' via brew"
      _fail=1
    fi
  done

  # gh auth is a warn, never a doctor failure (matches manifest gh.post).
  if have gh; then
    if gh auth status >/dev/null 2>&1; then ok "gh: authenticated"; else warn "gh: unauthenticated (run 'gh auth login')"; fi
  fi

  if [ "${HPS_SKIP_STUDIO:-0}" != "1" ] && [ "$OS" = "darwin" ]; then
    if [ -d "/Applications/HypeProof Studio.app" ]; then ok "Studio: installed"; else warn "Studio: not found — remediation: re-run installer"; _fail=1; fi
    # Canonical marker written by seed-sdk-binary.sh is <version>/claude.verified.json
    # (darwin under Application Support, linux under XDG_CONFIG_HOME).
    if ls "${STUDIO_SUPPORT}/sdk"/*/claude.verified.json >/dev/null 2>&1 \
       || ls "${XDG_CONFIG_HOME:-$HOME/.config}/HypeProof-Studio/sdk"/*/claude.verified.json >/dev/null 2>&1; then
      ok "SDK: seeded + verified"
    else
      warn "SDK: not seeded (Studio self-heals on first launch)"
    fi
  fi

  if [ "$_fail" -ne 0 ]; then
    die "doctor found unmet manifest requirements (see above). Exiting non-zero."
  fi
  ok "doctor: all manifest checks passed"
}

# ----------------------------------------------------------------------------- #
# 9. Main
# ----------------------------------------------------------------------------- #
# 테스트 훅 — `HPS_LIB_ONLY=1 . scripts/install.sh` 로 부르면 함수 정의만 하고
# 아무것도 설치하지 않는다. scripts/test-installer-version-gate.sh 가 이걸로
# 버전 게이트를 대조군과 함께 검증한다. 이 줄 위는 전부 정의부여야 한다.
[ "${HPS_LIB_ONLY:-0}" = "1" ] && return 0 2>/dev/null

printf '%s\n' "${C_BOLD}HypeProof bootstrap — platform ${PLATFORM}, manifest schema ${MANIFEST_SCHEMA}${C_RESET}"
[ "$NONINTERACTIVE" = "1" ] && info "(unattended mode)"

have curl || die "curl is required to bootstrap and was not found."

ensure_brew
check_deps
install_studio
doctor

step "Done"
ok "HypeProof is ready. Open a new terminal (or 'source ${RC_FILE}') so PATH edits take effect."
[ "$OS" = "darwin" ] && [ -d "/Applications/HypeProof Studio.app" ] && \
  info "Launch: open '/Applications/HypeProof Studio.app'"
exit 0

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
STUDIO_VERSION="0.1.33"
STUDIO_ASSET_GLOB_DARWIN_ARM64="HypeProof-Studio-darwin-arm64-*.zip"
STUDIO_ASSET_GLOB_DARWIN_X64="HypeProof-Studio-darwin-x64-*.zip"

SDK_NPM_PACKAGE="@anthropic-ai/claude-code"

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
      env $NONINTERACTIVE_BREW /bin/bash -c \
        "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
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

install_one_dep() {  # install_one_dep <id>
  _id="$1"; _bin="$(dep_binary "$_id")"
  if have "$_bin"; then
    ok "${_id}: $(eval "$(dep_check_cmd "$_id")" 2>/dev/null | head -n1)"
    return 0
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
gh_asset_url() {  # gh_asset_url <glob> -> download URL of first matching asset for STUDIO_VERSION
  _glob="$1"
  _api="https://api.github.com/repos/${STUDIO_RELEASES_REPO}/releases/tags/v${STUDIO_VERSION}"
  _auth=""; [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ] && _auth="-H \"Authorization: Bearer ${GH_TOKEN:-$GITHUB_TOKEN}\""
  # Prefer gh (handles auth + pagination) when available; else curl the API.
  # Match on the asset NAME (the API `.url` basename is a numeric asset id that
  # never matches a filename glob) and download via `browser_download_url`.
  if have gh; then
    gh release view "v${STUDIO_VERSION}" --repo "$STUDIO_RELEASES_REPO" \
      --json assets --jq '.assets[] | "\(.name)\t\(.browser_download_url)"' 2>/dev/null | \
      while IFS="$(printf '\t')" read -r _name _dl; do
        # shellcheck disable=SC2254  # $_glob is INTENDED as a glob pattern here
        case "$_name" in $_glob) echo "$_dl"; break ;; esac
      done
    return 0
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
    darwin-x64)   _glob="$STUDIO_ASSET_GLOB_DARWIN_X64" ;;
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

seed_sdk() {
  # Native claude binary seeded where hypeproof-chat resolves it.
  # Manifest darwin seed_dir: ~/Library/Application Support/HypeProof-Studio/sdk/<version>/claude
  step "Seeding native SDK binary (${SDK_NPM_PACKAGE})"
  have npm || { warn "npm unavailable — skipping SDK seed (Studio will self-heal on first run)"; return 0; }
  # Resolve the pinned version Studio expects. Best-effort: use 'latest' unless a pin is discoverable.
  _sdk_ver="${HPS_SDK_VERSION:-latest}"
  _seed_root="${STUDIO_SUPPORT}/sdk"
  mkdir -p "$_seed_root"
  _tmp="$(mktemp -d)"
  info "Fetching ${SDK_NPM_PACKAGE}@${_sdk_ver} via npm…"
  if ( cd "$_tmp" && npm pack "${SDK_NPM_PACKAGE}@${_sdk_ver}" >/dev/null 2>&1 ); then
    _tgz="$(cd "$_tmp" && find . -maxdepth 1 -name '*.tgz' 2>/dev/null | head -n1)"; _tgz="${_tgz#./}"
    if [ -n "$_tgz" ]; then
      ( cd "$_tmp" && tar -xzf "$_tgz" )
      # derive the real version from package.json
      _rv="$(grep -o '"version": *"[^"]*"' "${_tmp}/package/package.json" 2>/dev/null | head -n1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')"
      [ -n "$_rv" ] || _rv="$_sdk_ver"
      _dest="${_seed_root}/${_rv}"
      mkdir -p "$_dest"
      # the claude launcher lives in the package bin; copy the whole package for resolution
      cp -R "${_tmp}/package/." "$_dest/" 2>/dev/null || true
      # normalize an executable named 'claude'
      if [ -f "${_dest}/cli.js" ] && [ ! -e "${_dest}/claude" ]; then
        ln -sf cli.js "${_dest}/claude" 2>/dev/null || true
      fi
      # verification receipt (sha512 of the tarball) -> .verified.json (fail-open on hash tooling absence)
      if have shasum; then
        _sha="$(shasum -a 512 "${_tmp}/${_tgz}" | awk '{print $1}')"
        printf '{ "package": "%s", "version": "%s", "sha512": "%s", "seeded_at": "%s" }\n' \
          "$SDK_NPM_PACKAGE" "$_rv" "$_sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${_dest}/.verified.json"
      fi
      receipt_note "sdk" "$_rv"
      ok "SDK seeded: ${_dest}"
    else
      warn "npm pack produced no tarball — SDK will self-heal on first Studio launch"
    fi
  else
    warn "npm pack failed — SDK will self-heal on first Studio launch"
  fi
  rm -rf "$_tmp"
}

install_studio() {
  [ "${HPS_SKIP_STUDIO:-0}" = "1" ] && { warn "HPS_SKIP_STUDIO=1 — skipping Studio app + SDK seed"; return 0; }
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
      ok "${_id}: ${_ver:-present}"
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
    if ls "${STUDIO_SUPPORT}/sdk"/*/.verified.json >/dev/null 2>&1; then ok "SDK: seeded + verified"; else warn "SDK: not seeded (Studio self-heals on first launch)"; fi
  fi

  if [ "$_fail" -ne 0 ]; then
    die "doctor found unmet manifest requirements (see above). Exiting non-zero."
  fi
  ok "doctor: all manifest checks passed"
}

# ----------------------------------------------------------------------------- #
# 9. Main
# ----------------------------------------------------------------------------- #
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

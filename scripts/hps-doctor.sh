#!/bin/sh
# =============================================================================
# hps doctor — fail-closed runtime verifier for the HypeProof toolchain
#
#   scripts/hps-doctor.sh [--manifest PATH] [--no-studio] [--check-pip] [-h]
#
# ONE job: re-verify the SAME single-source-of-truth manifest (dependencies.yaml)
# that install.sh (macOS/Linux) and install.ps1 (Windows) install from. It is
# the last step of both installers and the PR gate CI runs on macos-14 +
# windows-2022 (see .github/workflows/skills-doctor-matrix.yml).
#
# Cross-platform by design: pure POSIX sh + grep/sed/awk. Runs on macOS, Linux,
# and Git Bash on Windows (uname -> MINGW*/MSYS*/CYGWIN*). No jq / no PyYAML
# dependency — the manifest is parsed with awk so the doctor still works when the
# very tools it verifies are missing (chicken-and-egg safe).
#
# WHAT IT CHECKS (fail-closed: any HARD failure -> non-zero exit + exact fix):
#   * every manifest tool: present on PATH, and >= its min_version pin
#       - tier required|recommended  -> HARD failure
#       - tier dev|maintainer        -> WARN only (opt-in tooling)
#       - platform-scoped: a tool not listed for this OS is skipped
#   * a reachable POSIX bash that actually executes a one-liner  (HARD)
#   * git present                                               (HARD, via manifest)
#   * gh auth status                                            (WARN, never fatal)
#   * the Studio SDK seed .verified.json integrity              (mac/desktop)
#   * (opt-in) pip_packages via the harness python3             (--check-pip)
#
# Flags / env:
#   --manifest PATH | HPS_DEPS_MANIFEST   override manifest location
#   --no-studio     | HPS_SKIP_STUDIO=1   deps-only pass (skip Studio app + SDK)
#   --check-pip     | HPS_CHECK_PIP=1     also verify manifest pip_packages
#   HPS_DEBUG=1                           xtrace
#
# Exit: 0 = all hard checks pass (warnings allowed); 1 = at least one hard fail.
# =============================================================================

set -u
[ "${HPS_DEBUG:-0}" = "1" ] && set -x

# ----------------------------------------------------------------------------- #
# 0. Args
# ----------------------------------------------------------------------------- #
MANIFEST_OVERRIDE="${HPS_DEPS_MANIFEST:-}"
SKIP_STUDIO="${HPS_SKIP_STUDIO:-0}"
CHECK_PIP="${HPS_CHECK_PIP:-0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --manifest) MANIFEST_OVERRIDE="${2:-}"; shift 2 || { echo "--manifest needs a PATH" >&2; exit 2; } ;;
    --manifest=*) MANIFEST_OVERRIDE="${1#*=}"; shift ;;
    --no-studio|--skip-studio) SKIP_STUDIO=1; shift ;;
    --check-pip) CHECK_PIP=1; shift ;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "hps-doctor: ignoring unknown argument: $1" >&2; shift ;;
  esac
done

# ----------------------------------------------------------------------------- #
# 1. Output helpers + counters
# ----------------------------------------------------------------------------- #
if [ -t 1 ]; then
  C_RESET="$(printf '\033[0m')"; C_BOLD="$(printf '\033[1m')"
  C_GREEN="$(printf '\033[32m')"; C_YELLOW="$(printf '\033[33m')"
  C_RED="$(printf '\033[31m')"; C_BLUE="$(printf '\033[36m')"
else
  C_RESET=""; C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_BLUE=""
fi

FAILS=0
WARNS=0
REMEDIATIONS=""   # newline-joined "fix" commands, printed in the final summary

section() { printf '\n%s\n' "${C_BOLD}${C_BLUE}== $* ==${C_RESET}"; }
ok()      { printf '  %s%s%s\n' "$C_GREEN" "ok    $*" "$C_RESET"; }
info()    { printf '  %s\n' "-     $*"; }

warn() {  # warn <message> [remediation]
  WARNS=$((WARNS + 1))
  printf '  %s%s%s\n' "$C_YELLOW" "warn  $1" "$C_RESET"
  [ $# -ge 2 ] && [ -n "$2" ] && printf '        %sfix:%s %s\n' "$C_YELLOW" "$C_RESET" "$2"
  return 0
}

fail() {  # fail <message> <remediation>
  FAILS=$((FAILS + 1))
  printf '  %s%s%s\n' "$C_RED" "FAIL  $1" "$C_RESET"
  if [ $# -ge 2 ] && [ -n "$2" ]; then
    printf '        %sfix:%s %s\n' "$C_RED" "$C_RESET" "$2"
    REMEDIATIONS="${REMEDIATIONS}${2}
"
  fi
  return 0
}

have() { command -v "$1" >/dev/null 2>&1; }

# ver_ge A B  -> success (0) iff dotted-numeric version A >= B. Non-numeric
# suffixes are already stripped by the extractor; missing fields default to 0.
ver_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN{
    na=split(a,A,"."); nb=split(b,B,".");
    n=(na>nb)?na:nb;
    for(i=1;i<=n;i++){ x=(i<=na?A[i]+0:0); y=(i<=nb?B[i]+0:0);
      if(x>y){ exit 0 } if(x<y){ exit 1 } }
    exit 0
  }'
}

# ----------------------------------------------------------------------------- #
# 2. Detect platform (POSIX token: macos | linux | windows)
# ----------------------------------------------------------------------------- #
UNAME_S="$(uname -s 2>/dev/null || echo unknown)"
case "$UNAME_S" in
  Darwin)                 OS=macos ;;
  Linux)                  OS=linux ;;
  MINGW*|MSYS*|CYGWIN*)   OS=windows ;;   # Git Bash / MSYS2 / Cygwin
  *)                      OS=linux ;;     # best-effort default
esac

# ----------------------------------------------------------------------------- #
# 2b. Resolve the POSIX interpreter name `python3` to a binary that exists here.
#
# The manifest is POSIX-shaped on purpose: it asks for `python3`, the name every
# Unix distro guarantees (PEP 394). Windows CPython ships `python.exe` ONLY —
# there is no `python3.exe` in the install dir. The only `python3.exe` on a
# stock Windows PATH is the 0-byte %LOCALAPPDATA%\Microsoft\WindowsApps
# reparse-point stub that opens the Microsoft Store.
#
# So a name-only lookup on Windows has two failure modes, and we hit the first:
#   * MISS  — Python 3.11.9 installed at
#             ~/AppData/Local/Programs/Python/Python311/python.exe, yet the
#             doctor reported "python: not found on PATH (tier=required)" and
#             told the user to `winget install Python.Python.3.11` again.
#   * WORSE — match the Store stub and either hang on a Store window or accept
#             a "python3" that cannot run a single line of code.
#
# Rule: NEVER accept a candidate on its name. A candidate is accepted only if it
# actually executes and prints a version that satisfies the manifest pin. That
# is what keeps `python` == python2 (2.7.x < 3.11) out and what makes the 0-byte
# stub fail closed instead of turning the check green.
#
# POSIX is untouched: on macOS/Linux the candidate list is exactly `python3`,
# so the resolved command is byte-identical to the manifest's and every verdict
# (missing / below-min / ok) is what it was before.
# ----------------------------------------------------------------------------- #
PY_PREFIX=""   # interpreter prefix chosen for this run ("" = none usable)

# resolve_python_prefix <min_version>
#   Prints the command prefix to use in place of `python3`, or "" if no
#   candidate even exists. Prefers the first candidate that runs AND reports
#   >= <min>; otherwise falls back to the first candidate that exists at all so
#   the caller still reports that one's REAL version / real error.
resolve_python_prefix() {
  _rp_min="${1:-}"
  if [ "$OS" = "windows" ]; then
    # Priority = what PATH would run first, then the documented Windows names.
    # `py -3` is the PEP 397 launcher (C:\Windows\py.exe), the last resort that
    # works even when no python*.exe is on PATH at all.
    set -- "python3" "python" "py -3"
  else
    set -- "python3"
  fi

  _rp_fallback=""
  for _rp_c in "$@"; do
    _rp_bin="${_rp_c%% *}"
    have "$_rp_bin" || continue

    # Microsoft Store "App Execution Alias" stubs are 0-byte reparse points that
    # launch the Store UI instead of running. Never execute one, never count it.
    _rp_path="$(command -v "$_rp_bin" 2>/dev/null || true)"
    if [ -n "$_rp_path" ] && [ -f "$_rp_path" ] && [ ! -s "$_rp_path" ]; then
      continue
    fi

    [ -n "$_rp_fallback" ] || _rp_fallback="$_rp_c"

    # Word splitting on $_rp_c is intentional: the list is a fixed literal and
    # "py -3" must reach the launcher as two argv entries.
    # shellcheck disable=SC2086
    _rp_out="$($_rp_c --version 2>&1 || true)"
    case "$_rp_out" in *[Pp]ython*) : ;; *) continue ;; esac
    _rp_ver="$(printf '%s\n' "$_rp_out" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n1)"
    [ -n "$_rp_ver" ] || continue
    if [ -z "$_rp_min" ] || [ "$_rp_min" = "null" ] || ver_ge "$_rp_ver" "$_rp_min"; then
      printf '%s\n' "$_rp_c"
      return 0
    fi
  done

  printf '%s\n' "$_rp_fallback"
  [ -n "$_rp_fallback" ]
}

# rewrite_python_check <check-command> <prefix>
#   Swaps a leading `python3`/`python3.11` token for the resolved prefix, so the
#   manifest's own check command still supplies the args and the version regex
#   surface stays exactly as authored.
rewrite_python_check() {
  _rw_check="$1"; _rw_prefix="$2"
  _rw_bin="${_rw_check%% *}"
  case "$_rw_bin" in
    python3|python3.*) printf '%s%s\n' "$_rw_prefix" "${_rw_check#"$_rw_bin"}" ;;
    *)                 printf '%s\n' "$_rw_check" ;;
  esac
}

# ----------------------------------------------------------------------------- #
# 3. Locate the manifest (single source of truth). Fail closed if absent.
# ----------------------------------------------------------------------------- #
case "$0" in
  */*) SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" ;;
  *)   SCRIPT_DIR="$(pwd)" ;;
esac

find_manifest() {
  [ -n "$MANIFEST_OVERRIDE" ] && { [ -f "$MANIFEST_OVERRIDE" ] && { printf '%s\n' "$MANIFEST_OVERRIDE"; return 0; }; return 1; }
  _git_top=""
  have git && _git_top="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
  for _c in \
    "$SCRIPT_DIR/../dependencies.yaml" \
    "$SCRIPT_DIR/../hypeproof-deps.yaml" \
    "$SCRIPT_DIR/dependencies.yaml" \
    "$SCRIPT_DIR/../config/dependencies.yaml" \
    "${_git_top:+$_git_top/dependencies.yaml}" \
    "${_git_top:+$_git_top/config/dependencies.yaml}" \
    "./dependencies.yaml" \
    "./hypeproof-deps.yaml"
  do
    [ -n "$_c" ] && [ -f "$_c" ] && { printf '%s\n' "$_c"; return 0; }
  done
  return 1
}

printf '%s\n' "${C_BOLD}hps doctor — platform ${OS}${C_RESET}"
[ "$SKIP_STUDIO" = "1" ] && info "Studio app + SDK checks skipped (deps-only pass)"

MANIFEST="$(find_manifest || true)"
if [ -z "$MANIFEST" ]; then
  section "manifest"
  fail "dependency manifest not found (dependencies.yaml)" \
       "place dependencies.yaml at the repo root, or run: HPS_DEPS_MANIFEST=/path/to/dependencies.yaml scripts/hps-doctor.sh"
  printf '\n%sdoctor: cannot verify without its single source of truth. Exiting non-zero.%s\n' "$C_RED" "$C_RESET" >&2
  exit 1
fi
ok "manifest: $MANIFEST"

# ----------------------------------------------------------------------------- #
# 4. Parse the manifest `tools:` block with awk.
#    Emits one TAB-separated row per tool:  id  tier  min  check  brew  winget  platforms
# ----------------------------------------------------------------------------- #
parse_tools() {
  awk '
    function trim(s){ sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s }
    function val(line){ s=substr(line, index(line,":")+1); s=trim(s);
                        if (s ~ /^".*"$/ || s ~ /^'"'"'.*'"'"'$/) s=substr(s,2,length(s)-2); return s }
    function flush(){ if(have){ printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", id,tier,min,chk,brew,wg,plat }; have=0 }
    /^tools:[ \t]*$/ { intools=1; next }
    /^[A-Za-z_][A-Za-z_]*:/ { if($0 !~ /^tools:/){ if(intools){ flush(); intools=0 } } }
    intools && /^  - id:/       { flush(); id=val($0); tier=""; min=""; chk=""; brew=""; wg=""; plat=""; ininst=0; have=1; next }
    intools && /^    tier:/         { tier=val($0); next }
    intools && /^    min_version:/  { min=val($0);  next }
    intools && /^    check:/        { chk=val($0);  next }
    intools && /^    install:/      { ininst=1; next }
    intools && ininst && /^      brew:/   { brew=val($0); next }
    intools && ininst && /^      winget:/ { wg=val($0);   next }
    intools && /^    platforms:/    { p=val($0); gsub(/[][ ]/,"",p); plat=p; ininst=0; next }
    intools && /^    [a-z]/         { ininst=0 }
    END{ flush() }
  ' "$1"
}

# ----------------------------------------------------------------------------- #
# 5. Remediation-command builders (grounded in manifest install.brew / winget)
# ----------------------------------------------------------------------------- #
# $1 id  $2 brew-pkg  $3 winget-pkg  $4 verb(install|upgrade)
remediate() {
  _rid="$1"; _brew="$2"; _wg="$3"; _verb="${4:-install}"
  case "$OS" in
    macos|linux)
      if [ -n "$_brew" ] && [ "$_brew" != "null" ]; then
        echo "brew ${_verb} ${_brew}"
      elif [ "$_rid" = "pre-commit" ]; then
        echo "python3 -m pip install --upgrade pre-commit"
      else
        echo "install '${_rid}' manually (no brew formula in manifest)"
      fi ;;
    windows)
      if [ -n "$_wg" ] && [ "$_wg" != "null" ]; then
        [ "$_verb" = "upgrade" ] && echo "winget upgrade --id ${_wg} -e --source winget" \
                                 || echo "winget install --id ${_wg} -e --source winget"
      else
        echo "no native Windows package for '${_rid}' — install it under WSL2 (see docs/MEMBER-GUIDE.ko.md §0)"
      fi ;;
  esac
}

# ----------------------------------------------------------------------------- #
# 6. Verify every manifest tool
# ----------------------------------------------------------------------------- #
section "toolchain (manifest schema — pinned versions)"

TOOLS_TMP="$(mktemp 2>/dev/null || echo /tmp/hps-doctor-tools.$$)"
parse_tools "$MANIFEST" > "$TOOLS_TMP" 2>/dev/null

if [ ! -s "$TOOLS_TMP" ]; then
  fail "manifest parsed 0 tools (is '$MANIFEST' a valid dependencies.yaml?)" \
       "verify the manifest has a top-level 'tools:' list"
fi

TAB="$(printf '\t')"
GIT_PRESENT=0
while IFS="$TAB" read -r id tier min check brew winget plat; do
  [ -n "$id" ] || continue

  # platform scope: skip a tool not listed for this OS
  if [ -n "$plat" ]; then
    case ",$plat," in
      *",$OS,"*) : ;;
      *) info "$id: not required on $OS (manifest platforms: $plat) — skipped"; continue ;;
    esac
  fi

  # tier -> severity
  case "$tier" in
    required|recommended) hard=1 ;;
    *)                    hard=0 ;;   # dev | maintainer | unknown -> advisory
  esac
  bin="${check%% *}"
  [ -n "$bin" ] || bin="$id"

  # POSIX interpreter name -> a binary that exists on THIS OS (see §2b). The pin
  # is passed in, so a candidate is only adopted when it reports >= $min; that
  # keeps a python2 named `python` from being adopted as "python3".
  case "$bin" in
    python3|python3.*)
      _pyc="$(resolve_python_prefix "$min" || true)"
      PY_PREFIX="$_pyc"
      if [ -n "$_pyc" ] && [ "$_pyc" != "$bin" ]; then
        info "$id: manifest asks for '$bin'; Windows CPython ships no python3.exe — using '$_pyc'"
        check="$(rewrite_python_check "$check" "$_pyc")"
        bin="${_pyc%% *}"
      fi
      ;;
  esac

  if ! have "$bin"; then
    _fix="$(remediate "$id" "$brew" "$winget" install)"
    if [ "$hard" = "1" ]; then
      fail "$id: not found on PATH (tier=$tier)" "$_fix"
    else
      warn "$id: not found on PATH (tier=$tier, optional)" "$_fix"
    fi
    continue
  fi
  [ "$id" = "git" ] && GIT_PRESENT=1

  # read installed version via the manifest's own check command
  out="$(sh -c "$check" 2>&1 || true)"
  ver="$(printf '%s\n' "$out" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n1)"

  if [ -z "$min" ] || [ "$min" = "null" ]; then
    ok "$id: ${ver:-present} (no pin)"
    continue
  fi
  if [ -z "$ver" ]; then
    warn "$id: present but version unreadable from: ${out%%
*}"
    continue
  fi
  if ver_ge "$ver" "$min"; then
    ok "$id: $ver (>= $min)"
  else
    _fix="$(remediate "$id" "$brew" "$winget" upgrade)"
    if [ "$hard" = "1" ]; then
      fail "$id: $ver is below the required minimum $min" "$_fix"
    else
      warn "$id: $ver is below minimum $min (tier=$tier, optional)" "$_fix"
    fi
  fi
done < "$TOOLS_TMP"
rm -f "$TOOLS_TMP" 2>/dev/null || true

# ----------------------------------------------------------------------------- #
# 7. Runtime assumptions the bundled skills hard-depend on
#    (mirrors the CI shell smoke; these are the assertions from installer step 9)
# ----------------------------------------------------------------------------- #
section "runtime assumptions"

# 7a. git present (also a required manifest tool; reported HARD there). Echo it here.
if [ "$GIT_PRESENT" = "1" ] || have git; then
  ok "git present: $(command -v git)"
else
  # Only reachable if git somehow absent from the manifest tool list.
  case "$OS" in
    windows) _bfix="winget install --id Git.Git -e --source winget" ;;
    *)       _bfix="brew install git" ;;
  esac
  fail "git not found on PATH" "$_bfix"
fi

# 7b. a reachable POSIX bash that actually executes (Git Bash on Windows).
#     Distinct from the manifest 'bash' (v5+) tool check, which is maintainer-tier.
if have bash && bash -c 'exit 0' 2>/dev/null && \
   [ "$(bash -c 'printf posix-bash-ok' 2>/dev/null)" = "posix-bash-ok" ]; then
  ok "POSIX bash reachable + executes: $(command -v bash)"
else
  case "$OS" in
    windows) _bfix="winget install --id Git.Git -e --source winget   (bundles Git Bash at C:\\Program Files\\Git\\bin\\bash.exe)" ;;
    macos)   _bfix="bash is preinstalled on macOS; if missing run: brew install bash" ;;
    *)       _bfix="install bash via your package manager (e.g. apt-get install bash)" ;;
  esac
  fail "no reachable POSIX bash — bundled SKILL.md / *.sh cannot run" "$_bfix"
fi

# 7c. gh auth — WARN only, never fatal (matches manifest gh.post).
if have gh; then
  if gh auth status >/dev/null 2>&1; then
    ok "gh: authenticated"
  else
    warn "gh: not authenticated (PR / review / merge skills will fail)" "gh auth login"
  fi
fi

# ----------------------------------------------------------------------------- #
# 8. Studio app + native SDK seed (.verified.json)  [skipped with --no-studio]
# ----------------------------------------------------------------------------- #
if [ "$SKIP_STUDIO" != "1" ]; then
  section "HypeProof Studio + native SDK"

  # candidate SDK seed roots across OSes (mac / linux XDG / Git Bash %APPDATA%)
  SEED_ROOTS=""
  add_root() { [ -n "$1" ] && SEED_ROOTS="${SEED_ROOTS}$1
"; }
  add_root "$HOME/Library/Application Support/HypeProof-Studio/sdk"
  # Linux: seed-sdk-binary.sh writes under XDG_CONFIG_HOME (~/.config). The
  # XDG_DATA_HOME root is kept as a secondary candidate for older seeds.
  add_root "${XDG_CONFIG_HOME:-$HOME/.config}/HypeProof-Studio/sdk"
  add_root "${XDG_DATA_HOME:-$HOME/.local/share}/HypeProof-Studio/sdk"
  [ -n "${APPDATA:-}" ]     && add_root "$(printf '%s' "$APPDATA" | sed 's#\\\\#/#g; s#\\#/#g')/HypeProof-Studio/sdk"
  [ -n "${USERPROFILE:-}" ] && add_root "$(printf '%s' "$USERPROFILE" | sed 's#\\\\#/#g; s#\\#/#g')/AppData/Roaming/HypeProof-Studio/sdk"
  add_root "$HOME/AppData/Roaming/HypeProof-Studio/sdk"

  # Studio desktop app (hard on macOS where a first-class build exists).
  if [ "$OS" = "macos" ]; then
    if [ -d "/Applications/HypeProof Studio.app" ]; then
      ok "Studio app: /Applications/HypeProof Studio.app"
    else
      fail "Studio app not found in /Applications" \
           "re-run the installer:  curl -fsSL https://raw.githubusercontent.com/jayleekr/hypeproof-studio/main/scripts/install.sh | bash"
    fi
  else
    info "Studio desktop app check skipped on $OS (no first-class build / path varies)"
  fi

  # SDK seed marker integrity. The canonical marker is written by
  # scripts/seed-sdk-binary.{sh,ps1} NEXT TO the binary it describes:
  #   <root>/<version>/claude.verified.json       (macOS / Linux)
  #   <root>/<version>/claude.exe.verified.json   (Windows)
  # Schema: { sdkVersion, size, tarballSha512, verifiedAt, seededBy }.
  VERIFIED_FILE=""
  OLDIFS="$IFS"; IFS='
'
  for _root in $SEED_ROOTS; do
    [ -d "$_root" ] || continue
    for _vf in "$_root"/*/claude.verified.json "$_root"/*/claude.exe.verified.json; do
      [ -f "$_vf" ] && { VERIFIED_FILE="$_vf"; break; }
    done
    [ -n "$VERIFIED_FILE" ] && break
  done
  IFS="$OLDIFS"

  if [ -z "$VERIFIED_FILE" ]; then
    # Not yet seeded is not fatal: Studio self-heals the SDK on first launch.
    warn "native SDK not seeded (no claude[.exe].verified.json under any HypeProof-Studio/sdk)" \
         "launch Studio once to self-heal, or run: bash scripts/seed-sdk-binary.sh"
  else
    SEEDED_BIN="${VERIFIED_FILE%.verified.json}"
    MK_VER="$(sed -n 's/.*"sdkVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$VERIFIED_FILE" 2>/dev/null | head -n1)"
    MK_SIZE="$(sed -n 's/.*"size"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$VERIFIED_FILE" 2>/dev/null | head -n1)"
    BIN_SIZE=""
    [ -f "$SEEDED_BIN" ] && BIN_SIZE="$(wc -c < "$SEEDED_BIN" 2>/dev/null | tr -d ' ')"
    _reseed="delete the seed dir and re-run scripts/seed-sdk-binary.sh to re-seed + re-verify the SDK"

    if [ -z "$MK_VER" ] || [ -z "$MK_SIZE" ] \
       || ! grep -q '"tarballSha512"[[:space:]]*:[[:space:]]*"sha512-' "$VERIFIED_FILE" 2>/dev/null; then
      fail "SDK seed receipt is malformed (need sdkVersion + size + tarballSha512): $VERIFIED_FILE" "$_reseed"
    elif [ -z "$BIN_SIZE" ]; then
      fail "SDK seed receipt has no binary beside it: $SEEDED_BIN is missing" "$_reseed"
    elif [ "$BIN_SIZE" != "$MK_SIZE" ]; then
      # Same trust test the runtime applies (isSeededBinaryTrusted): marker size
      # must equal the on-disk binary size.
      fail "SDK seed size mismatch (marker $MK_SIZE, binary $BIN_SIZE): $SEEDED_BIN" "$_reseed"
    else
      ok "SDK seed verified: $MK_VER ($VERIFIED_FILE)"
    fi
  fi
fi

# ----------------------------------------------------------------------------- #
# 9. Optional: manifest pip_packages via the harness python3  (--check-pip)
# ----------------------------------------------------------------------------- #
if [ "$CHECK_PIP" = "1" ]; then
  section "python packages (pip_packages — opt-in)"
  # Reuse the interpreter §6 already resolved+version-verified; if the python
  # tool was skipped there (platform scope), resolve now against meta.python_min
  # so we never fall back to an unversioned guess.
  PY_MIN="$(sed -n 's/^[ \t]*python_min:[ \t]*"\{0,1\}\([0-9][0-9.]*\)"\{0,1\}[ \t]*$/\1/p' "$MANIFEST" 2>/dev/null | head -n1)"
  [ -n "$PY_PREFIX" ] || PY_PREFIX="$(resolve_python_prefix "$PY_MIN" || true)"
  if [ -z "$PY_PREFIX" ]; then
    warn "no python3 interpreter on PATH — cannot verify pip_packages" "install python (see toolchain section)"
  else
    info "pip_packages verified with: $PY_PREFIX"
    # parse pip_packages block (id / tier / min_version / check)
    PIP_TMP="$(mktemp 2>/dev/null || echo /tmp/hps-doctor-pip.$$)"
    awk '
      function trim(s){ sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s }
      function val(line){ s=substr(line, index(line,":")+1); s=trim(s);
                          if (s ~ /^".*"$/ || s ~ /^'"'"'.*'"'"'$/) s=substr(s,2,length(s)-2); return s }
      function flush(){ if(have){ printf "%s\t%s\t%s\t%s\n", id,tier,min,chk }; have=0 }
      /^pip_packages:[ \t]*$/ { inpip=1; next }
      /^[A-Za-z_][A-Za-z_]*:/ { if($0 !~ /^pip_packages:/){ if(inpip){ flush(); inpip=0 } } }
      inpip && /^  - id:/          { flush(); id=val($0); tier=""; min=""; chk=""; have=1; next }
      inpip && /^    tier:/        { tier=val($0); next }
      inpip && /^    min_version:/ { min=val($0); next }
      inpip && /^    check:/       { chk=val($0); next }
      END{ flush() }
    ' "$MANIFEST" > "$PIP_TMP" 2>/dev/null

    while IFS="$TAB" read -r id tier min check; do
      [ -n "$id" ] || continue
      case "$tier" in required|recommended) hard=1 ;; *) hard=0 ;; esac
      _fix="$PY_PREFIX -m pip install '${id}>=${min}'"
      check="$(rewrite_python_check "$check" "$PY_PREFIX")"
      out="$(sh -c "$check" 2>&1 || true)"
      ver="$(printf '%s\n' "$out" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n1)"
      if [ -z "$ver" ]; then
        if [ "$hard" = "1" ]; then fail "$id: not importable (tier=$tier)" "$_fix"
        else warn "$id: not importable (tier=$tier, optional)" "$_fix"; fi
      elif [ -z "$min" ] || ver_ge "$ver" "$min"; then
        ok "$id: $ver${min:+ (>= $min)}"
      else
        if [ "$hard" = "1" ]; then fail "$id: $ver below minimum $min" "$_fix"
        else warn "$id: $ver below minimum $min (optional)" "$_fix"; fi
      fi
    done < "$PIP_TMP"
    rm -f "$PIP_TMP" 2>/dev/null || true
  fi
fi

# ----------------------------------------------------------------------------- #
# 10. Verdict
# ----------------------------------------------------------------------------- #
section "verdict"
if [ "$FAILS" -gt 0 ]; then
  printf '  %s%d hard failure(s), %d warning(s)%s\n' "$C_RED" "$FAILS" "$WARNS" "$C_RESET"
  printf '\n%sRemediation — run these, then re-run scripts/hps-doctor.sh:%s\n' "$C_BOLD" "$C_RESET"
  printf '%s' "$REMEDIATIONS" | sed '/^$/d' | sort -u | sed 's/^/    /'
  exit 1
fi
if [ "$WARNS" -gt 0 ]; then
  printf '  %sall hard checks passed (%d warning(s) — non-fatal)%s\n' "$C_GREEN" "$WARNS" "$C_RESET"
else
  printf '  %sall checks passed%s\n' "$C_GREEN" "$C_RESET"
fi
exit 0

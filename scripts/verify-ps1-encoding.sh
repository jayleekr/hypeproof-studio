#!/usr/bin/env bash
# verify-ps1-encoding.sh - fail-closed gate: every tracked .ps1 carries the
# encoding its EXECUTION MODE requires. The two modes want opposite things, so
# a single rule for all files necessarily breaks one of them.
#
#   mode: file   run as `powershell -File x.ps1`
#     BOM REQUIRED when the file has non-ASCII bytes.
#     Windows PowerShell 5.1 reads a BOM-less .ps1 using the ANSI codepage, not
#     UTF-8. On a CP1252 machine the UTF-8 bytes of an em-dash (E2 80 94) decode
#     to "a", the euro sign, and 0x94 -> U+201D RIGHT DOUBLE QUOTATION MARK.
#     PowerShell accepts smart quotes as string delimiters, so an em-dash inside
#     a double-quoted string terminates it early and the file no longer parses.
#     Bytes 0x91-0x94 are the dangerous set. Observed: seed-sdk-binary.ps1 (441
#     such bytes) failed with 16 parse errors and took install.ps1 step 7 (SDK
#     seeding) down with it.
#
#   mode: irm    run as `irm <url> | iex`
#     BOM FORBIDDEN, unconditionally.
#     Invoke-RestMethod decodes using the HTTP charset and leaves the BOM in the
#     string as U+FEFF. `iex` parses that STRING, not a file, so the leading
#     U+FEFF corrupts the first token and the whole script fails to parse -
#     nothing runs at all. Measured on the published one-liner: 3 parse errors
#     (UnexpectedAttribute CmdletBinding / UnexpectedToken param /
#     InvalidLeftHandSide); stripping the BOM alone gives 0.
#     Non-ASCII is fine in this mode - Invoke-RestMethod honours
#     `Content-Type: charset=utf-8` regardless of the host codepage.
#
# NOTE: an earlier revision of this file claimed `irm | iex` reads the file
# using the ANSI codepage. It does not - that is the `-File` path. The two
# modes were conflated, which is how the BOM added for the seeder ended up on
# install.ps1 and broke the published one-liner for every participant.
#
# Unclassified .ps1 files are an ERROR, not a skip: adding a script means
# deciding how it is executed.
#
# Usage: bash scripts/verify-ps1-encoding.sh
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- classification -------------------------------------------------------
# One entry per tracked .ps1. Format: "<mode> <path>".
MODES="
irm  scripts/install.ps1
irm  scripts/install-win.ps1
file scripts/seed-sdk-binary.ps1
"

mode_for() {
  local target="$1" mode path
  while read -r mode path; do
    [ -n "$mode" ] || continue
    if [ "$path" = "$target" ]; then
      printf '%s' "$mode"
      return 0
    fi
  done <<EOF
$MODES
EOF
  return 1
}

fail=0
checked=0

while IFS= read -r f; do
  [ -f "$f" ] || continue
  checked=$((checked + 1))

  if ! mode=$(mode_for "$f"); then
    echo "ERROR: $f is not classified in verify-ps1-encoding.sh"
    echo "       Add it to MODES as 'irm <path>' (published one-liner, no BOM)"
    echo "       or 'file <path>' (executed as a file, BOM required)."
    fail=1
    continue
  fi

  bom=$(head -c 3 "$f" | od -An -tx1 | tr -d ' \n')
  # `tr -d` of the ASCII range leaves only the offenders (portable: GNU + BSD).
  non_ascii=$(LC_ALL=C tr -d '\000-\177' < "$f" | wc -c | tr -d ' ')

  case "$mode" in
    irm)
      if [ "$bom" = "efbbbf" ]; then
        echo "ERROR: $f is consumed as \`irm ... | iex\` and must NOT have a UTF-8 BOM"
        echo "       The BOM survives decoding as U+FEFF and \`iex\` fails to parse the"
        echo "       string, so the published one-liner runs nothing at all."
        echo "       Fix: rewrite the file without the BOM (content unchanged)."
        fail=1
      fi
      ;;
    file)
      if [ "$bom" != "efbbbf" ] && [ "$non_ascii" != "0" ]; then
        echo "ERROR: $f has $non_ascii non-ASCII byte(s) and no UTF-8 BOM"
        echo "       Windows PowerShell 5.1 will read it as ANSI and may fail to parse."
        echo "       Fix: save as UTF-8 with BOM, or restrict the file to ASCII."
        fail=1
      fi
      ;;
  esac
done < <(git ls-files '*.ps1')

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "verify-ps1-encoding: FAILED"
  exit 1
fi

echo "verify-ps1-encoding: OK ($checked .ps1 file(s) checked)"

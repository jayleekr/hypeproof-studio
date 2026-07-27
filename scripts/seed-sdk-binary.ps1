#Requires -Version 5.1
<#
.SYNOPSIS
  seed-sdk-binary.ps1 — Windows companion to scripts/seed-sdk-binary.sh
  (#282 W4a, docs/sdk-bundling.md §5). Pre-seeds the Claude Agent SDK native
  `claude.exe` for venue machines.

.DESCRIPTION
  Downloads the win32 platform tarball DIRECTLY from the npm registry (no npm/
  node required on the target machine), verifies its sha512 against the pinned
  manifest, extracts `package/claude.exe` to the per-user seeded location the
  Studio extension resolves (sdkCoachHelpers.seededSdkBinaryPath, win32 branch),
  and writes the `.verified.json` integrity marker the runtime trusts (full
  sha512 runs ONCE here; the extension checks marker + size).

  Seeded location (must stay in lockstep with seededSdkBinaryPath):
    win32 — %APPDATA%\HypeProof-Studio\sdk\<version>\claude.exe

  This closes the Scout gap: seed-sdk-binary.sh hard-errors on win32
  ("win32 seeding is documented in the header but not automated by this
  script"). This script IS that automation. darwin/linux stay on the .sh.

  Idempotent: an already-seeded binary with a valid marker exits 0 untouched.
  Fail-closed: any sha512 mismatch, missing tarball member, or unsupported
  platform aborts without writing a partial/unverified seed.

.PARAMETER Version
  Explicit SDK version. Default: the pinned version (registry integrity is
  fetched for a non-pinned version instead of the local sha512 table).

.PARAMETER Tarball
  Path to a local *.tgz (air-gapped mode); skips the registry download.

.PARAMETER Platform
  Force a platform key (win32-x64 | win32-arm64). Default: auto-detected.

.PARAMETER Force
  Re-seed over an existing valid install.

.EXAMPLE
  irm https://.../seed-sdk-binary.ps1 | iex          # networked venue machine

.EXAMPLE
  pwsh scripts/seed-sdk-binary.ps1 -Tarball D:\usb\claude-agent-sdk-win32-x64-0.3.207.tgz

.EXAMPLE
  pwsh scripts/seed-sdk-binary.ps1 -Force            # re-seed over an existing install
#>
[CmdletBinding()]
param(
  [string]$Version = '',
  [string]$Tarball = '',
  [ValidateSet('', 'win32-x64', 'win32-arm64', 'darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64')]
  [string]$Platform = '',
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ── Pinned manifest ──────────────────────────────────────────────────────────
# Single source of truth is extensions/hypeproof-chat/src/sdkBinaryManifest.ts
# (itself locked to package-lock.json). Keep these values in lockstep with that
# manifest AND scripts/seed-sdk-binary.sh — bump all three together with the dep.
$PINNED_VERSION = '0.3.207'
$PINNED_SHA512 = @{
  'darwin-arm64' = 'sha512-08xSo1FDx8h0aLhL5tvcRxa2SMmcUV3aDWeZiEJVTclyiDAs61BgTjAxCg+SZcu1CndjJO8cfO0yM5dhamxz3g=='
  'darwin-x64'   = 'sha512-1o7K4EYqyCixZ/oeOZSh7AzSy6TM86xoOuf4VuORjPSS31hBnoqY0NGZd27+2VDs9LGtsdksmsTqcNGx9xd1hA=='
  'win32-x64'    = 'sha512-YPjVT0q6aXEM2MgN4CI6/9fqiTXwETji+4NoPOzCYuqAkhXZqp30Jsk7/NHqYGNNSfURKrsuAoliKB0rsbpbjg=='
  'win32-arm64'  = 'sha512-9fWpUzfkXlPAg2tf8JpQe7w9avFaomAUbfAwyAmykQgSIf66LwaJjvI5hNqhNqczRKyfsXPn3ei2S5HKlmFP+Q=='
  'linux-x64'    = 'sha512-Kg6BPH8Ee0ny/oEUWJmvT1jCRBne4jVpRSOMsJcYp1Fav1rMEgpU219oJJs+LWwx4ifuuLtNWedqJNnVw7mnKg=='
  'linux-arm64'  = 'sha512-X4uezYOifDiNTTmmugfRCdg3nNamrr1LFRY9hg30vWYTShL+bbN+nfC3KaFfSYCl4GTtsEEUbYdOTC2F3bBpcA=='
}

function Say([string]$m) { Write-Host "`n▶ $m" -ForegroundColor Magenta }
function Fail([string]$m) { Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }

# ── Platform detection (win32 is this script's first-class target) ───────────
if (-not $Platform) {
  # PowerShell Core defines $IsWindows; Windows PowerShell 5.1 does not (always Win).
  $onWindows = -not (Test-Path 'variable:IsWindows') -or $IsWindows
  if (-not $onWindows) {
    Fail "This is the win32 seeder. On macOS/Linux run scripts/seed-sdk-binary.sh, or pass -Platform explicitly."
  }
  $arch = $env:PROCESSOR_ARCHITEW6432
  if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
  switch ($arch) {
    'AMD64' { $Platform = 'win32-x64' }
    'ARM64' { $Platform = 'win32-arm64' }
    'x86'   { Fail "32-bit Windows (x86) has no SDK binary — a 64-bit OS is required." }
    default { Fail "Unsupported Windows arch '$arch' — pass -Platform explicitly (win32-x64 | win32-arm64)." }
  }
}
if ($Platform -notlike 'win32-*') {
  Fail "non-win32 seeding ($Platform) is handled by scripts/seed-sdk-binary.sh, not this script."
}

# ── Version resolution: pinned by default, cross-checked against the repo ────
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$lockfile = Join-Path $scriptDir '..\extensions\hypeproof-chat\package-lock.json'
if (-not $Version) {
  $Version = $PINNED_VERSION
  # Drift guard when run from the repo: the extension lockfile is the ultimate
  # pin for the SDK dependency. Fail loudly instead of seeding a mismatch.
  if (Test-Path -LiteralPath $lockfile) {
    $lockMatch = Select-String -Path $lockfile `
      -Pattern 'claude-agent-sdk/-/claude-agent-sdk-([0-9][0-9.]*)\.tgz' |
      Select-Object -First 1
    if ($lockMatch) {
      $lockVersion = $lockMatch.Matches[0].Groups[1].Value
      if ($lockVersion -and $lockVersion -ne $Version) {
        Fail "Pinned version $Version disagrees with extension package-lock.json ($lockVersion). Update `$PINNED_VERSION + the sha512 table (and sdkBinaryManifest.ts) together with the dependency."
      }
    }
  }
}

# ── Expected integrity ───────────────────────────────────────────────────────
$pkg = "@anthropic-ai/claude-agent-sdk-$Platform"
$tgzUrl = "https://registry.npmjs.org/$pkg/-/claude-agent-sdk-$Platform-$Version.tgz"
if ($Version -eq $PINNED_VERSION) {
  $expectedSha = $PINNED_SHA512[$Platform]
  if (-not $expectedSha) { Fail "No pinned sha512 for platform $Platform" }
} else {
  Say "Non-pinned version $Version — fetching dist.integrity from the npm registry"
  try {
    $meta = Invoke-RestMethod -UseBasicParsing -Uri "https://registry.npmjs.org/$pkg/$Version"
    $expectedSha = $meta.dist.integrity
  } catch {
    $expectedSha = ''
  }
  if (-not $expectedSha -or -not $expectedSha.StartsWith('sha512-')) {
    Fail "Could not read dist.integrity for $pkg@$Version from the registry"
  }
}

# ── Destination (keep in lockstep with seededSdkBinaryPath, win32 branch) ────
$appData = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $env:USERPROFILE 'AppData\Roaming' }
$destDir = Join-Path $appData (Join-Path 'HypeProof-Studio' (Join-Path 'sdk' $Version))
$destBin = Join-Path $destDir 'claude.exe'
$marker = "$destBin.verified.json"

# ── Idempotency: a valid existing seed is left untouched ─────────────────────
# On win32 "executable" == exists (X_OK is not meaningful), matching
# isSeededBinaryTrusted's win32 convention.
if (-not $Force -and (Test-Path -LiteralPath $destBin) -and (Test-Path -LiteralPath $marker)) {
  $curSize = (Get-Item -LiteralPath $destBin).Length
  $ok = $false
  try {
    $existing = Get-Content -Raw -LiteralPath $marker | ConvertFrom-Json
    if ($existing.sdkVersion -eq $Version -and [int64]$existing.size -eq $curSize) { $ok = $true }
  } catch { $ok = $false }
  if ($ok) {
    Say 'Already seeded and verified — nothing to do'
    Write-Host ("  binary : {0}`n  size   : {1} bytes`n  marker : {2}" -f $destBin, $curSize, $marker)
    exit 0
  }
  Say "Existing seed at $destBin failed the marker/size check — re-seeding"
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("hps-sdk-seed-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {

  # ── Obtain the tarball ─────────────────────────────────────────────────────
  if ($Tarball) {
    if (-not (Test-Path -LiteralPath $Tarball)) { Fail "Tarball not found: $Tarball" }
    Say "Using local tarball (air-gapped mode): $Tarball"
    $tgz = $Tarball
  } else {
    Say "Downloading $pkg@$Version (~67 MiB) from the npm registry"
    $tgz = Join-Path $tmp 'sdk.tgz'
    $downloaded = $false
    for ($i = 1; $i -le 3 -and -not $downloaded; $i++) {
      try {
        Invoke-WebRequest -UseBasicParsing -Uri $tgzUrl -OutFile $tgz
        $downloaded = $true
      } catch {
        if ($i -eq 3) { Fail "Download failed after 3 attempts: $($_.Exception.Message)" }
        Start-Sleep -Seconds ($i * 2)
      }
    }
  }

  # ── Verify sha512 (SRI base64 form, same value npm enforces) ───────────────
  Say 'Verifying sha512'
  $sha = [System.Security.Cryptography.SHA512]::Create()
  $fs = [System.IO.File]::OpenRead($tgz)
  try { $digest = $sha.ComputeHash($fs) } finally { $fs.Dispose(); $sha.Dispose() }
  $actualSha = 'sha512-' + [Convert]::ToBase64String($digest)
  if ($actualSha -ne $expectedSha) {
    Fail ("sha512 mismatch for $tgz`n  expected: $expectedSha`n  actual:   $actualSha`nRefusing to install. (Corrupt download? Wrong -Version/-Tarball?)")
  }
  Write-Host "  ok: $actualSha"

  # ── Extract + install atomically ───────────────────────────────────────────
  Say 'Extracting package/claude.exe'
  $tarExe = Get-Command tar.exe -ErrorAction SilentlyContinue
  if (-not $tarExe) { $tarExe = Get-Command tar -ErrorAction SilentlyContinue }
  if (-not $tarExe) {
    Fail 'tar is required to extract the tarball (built in on Windows 10 1803+). Install it or extract package/claude.exe manually.'
  }
  & $tarExe.Source -xzf $tgz -C $tmp 'package/claude.exe'
  if ($LASTEXITCODE -ne 0) { Fail 'tar extraction failed.' }
  $extractedBin = Join-Path $tmp (Join-Path 'package' 'claude.exe')
  if (-not (Test-Path -LiteralPath $extractedBin)) { Fail 'Tarball did not contain package/claude.exe' }

  New-Item -ItemType Directory -Force -Path $destDir | Out-Null
  $binSize = (Get-Item -LiteralPath $extractedBin).Length
  Move-Item -LiteralPath $extractedBin -Destination $destBin -Force

  # ── Write the runtime-trusted marker (see sdkBinaryManifest.ts trust model) ─
  # Schema MUST match sdkCoachHelpers.parseSdkBinaryMarker / isSeededBinaryTrusted:
  # sdkVersion (string), size (number), tarballSha512 (string, "sha512-…").
  $now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  $markerJson = @"
{
  "sdkVersion": "$Version",
  "size": $binSize,
  "tarballSha512": "$expectedSha",
  "verifiedAt": "$now",
  "seededBy": "scripts/seed-sdk-binary.ps1"
}
"@
  # UTF-8 without BOM so JSON.parse in the extension reads it cleanly.
  [System.IO.File]::WriteAllText($marker, $markerJson, (New-Object System.Text.UTF8Encoding($false)))

  # ── Verification printout ──────────────────────────────────────────────────
  Say 'Seeded successfully'
  Write-Host "  binary : $destBin"
  Write-Host "  size   : $binSize bytes"
  Write-Host "  sha512 : $actualSha (tarball, verified)"
  Write-Host "  marker : $marker"
  $launched = $false
  try {
    $ver = (& $destBin --version 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -eq 0 -and $ver) { Write-Host "  launch : $ver"; $launched = $true }
  } catch { $launched = $false }
  if (-not $launched) {
    Write-Host '  launch : (skipped — binary did not answer --version here; Studio will still verify at runtime)'
  }
}
finally {
  Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
}

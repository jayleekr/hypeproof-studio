<#
.SYNOPSIS
  seed-sdk-binary.ps1 — Windows instructor pre-seed of the Claude Agent SDK
  native `claude.exe` for venue machines (#282 W4a / #426, the win32 companion
  to scripts/seed-sdk-binary.sh).

.DESCRIPTION
  Downloads the win32 platform tarball DIRECTLY from the npm registry (no
  npm/node required on the target machine), verifies its sha512 against the
  pinned manifest, extracts `package/claude.exe` to the per-user seeded location
  the Studio extension resolves (sdkCoachHelpers.seededSdkBinaryPath), and writes
  the `.verified.json` integrity marker the runtime trusts (full sha512 runs ONCE
  here; the extension checks marker + size, isSeededBinaryTrusted).

  Seeded location (must stay in lockstep with seededSdkBinaryPath):
    win32 — %APPDATA%\HypeProof-Studio\sdk\<version>\claude.exe

  Idempotent: an already-seeded binary with a valid marker exits 0 untouched.
  Note: the SDK JS (sdk.mjs) ships inside the app (fixed for Windows by #402);
  this script only supplies the native binary half.

.PARAMETER Version
  Explicit SDK version (default: pinned 0.3.207). Non-pinned → registry integrity.

.PARAMETER Tarball
  Local .tgz path (air-gapped mode) instead of downloading.

.PARAMETER Platform
  win32-x64 (default) or win32-arm64. Auto-detected from the OS architecture.

.PARAMETER Force
  Re-seed over an existing install.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\seed-sdk-binary.ps1
.EXAMPLE
  powershell -File scripts\seed-sdk-binary.ps1 -Tarball D:\claude-agent-sdk-win32-x64-0.3.207.tgz
#>
[CmdletBinding()]
param(
  [string]$Version = "",
  [string]$Tarball = "",
  [ValidateSet("", "win32-x64", "win32-arm64")]
  [string]$Platform = "",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

# ── Pinned manifest ──────────────────────────────────────────────────────────
# Single source of truth is extensions/hypeproof-chat/src/sdkBinaryManifest.ts
# (itself locked to package-lock.json). Keep these in lockstep with that manifest
# AND scripts/seed-sdk-binary.sh — bump all three together with the SDK dep.
$PinnedVersion = "0.3.207"
$PinnedSha512 = @{
  "win32-x64"   = "sha512-YPjVT0q6aXEM2MgN4CI6/9fqiTXwETji+4NoPOzCYuqAkhXZqp30Jsk7/NHqYGNNSfURKrsuAoliKB0rsbpbjg=="
  "win32-arm64" = "sha512-9fWpUzfkXlPAg2tf8JpQe7w9avFaomAUbfAwyAmykQgSIf66LwaJjvI5hNqhNqczRKyfsXPn3ei2S5HKlmFP+Q=="
}

function Say($msg)  { Write-Host "`n▶ $msg" -ForegroundColor Magenta }
function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# ── Platform detection (win32-x64 is the first-class target) ─────────────────
if (-not $Platform) {
  $arch = $env:PROCESSOR_ARCHITECTURE
  switch ($arch) {
    "AMD64" { $Platform = "win32-x64" }
    "ARM64" { $Platform = "win32-arm64" }
    "x86"   { $Platform = "win32-x64" }   # 32-bit shell on 64-bit OS → x64 binary
    default { Fail "Unsupported architecture '$arch' — pass -Platform explicitly (win32-x64 | win32-arm64)" }
  }
}
if ($Platform -notin @("win32-x64", "win32-arm64")) { Fail "This script seeds win32 only. For darwin/linux use seed-sdk-binary.sh." }

# ── Version resolution: pinned by default, cross-checked against the repo ─────
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$lockFile  = Join-Path $scriptDir "..\extensions\hypeproof-chat\package-lock.json"
if (-not $Version) {
  $Version = $PinnedVersion
  # Drift guard when run from the repo: the extension lockfile is the ultimate
  # pin for the SDK dependency. Fail loudly instead of seeding a mismatch.
  if (Test-Path $lockFile) {
    $m = Select-String -Path $lockFile -Pattern 'claude-agent-sdk/-/claude-agent-sdk-([0-9][0-9.]*)\.tgz' | Select-Object -First 1
    if ($m) {
      $lockVersion = $m.Matches[0].Groups[1].Value
      if ($lockVersion -and $lockVersion -ne $Version) {
        Fail "Pinned version $Version disagrees with extension package-lock.json ($lockVersion). Update PinnedVersion + sha512 table (and sdkBinaryManifest.ts / seed-sdk-binary.sh) together with the dependency."
      }
    }
  }
}

# ── Expected integrity ───────────────────────────────────────────────────────
$pkg    = "@anthropic-ai/claude-agent-sdk-$Platform"
$tgzUrl = "https://registry.npmjs.org/$pkg/-/claude-agent-sdk-$Platform-$Version.tgz"
if ($Version -eq $PinnedVersion) {
  $expectedSha = $PinnedSha512[$Platform]
  if (-not $expectedSha) { Fail "No pinned sha512 for platform $Platform" }
} else {
  Say "Non-pinned version $Version — fetching dist.integrity from the npm registry"
  try {
    $meta = Invoke-RestMethod -Uri "https://registry.npmjs.org/$pkg/$Version" -UseBasicParsing
    $expectedSha = $meta.dist.integrity
  } catch { $expectedSha = $null }
  if (-not $expectedSha) { Fail "Could not read dist.integrity for $pkg@$Version from the registry" }
}

# ── Destination (keep in lockstep with seededSdkBinaryPath, win32 branch) ─────
$destDir = Join-Path $env:APPDATA "HypeProof-Studio\sdk\$Version"
$destBin = Join-Path $destDir "claude.exe"
$marker  = "$destBin.verified.json"
$minBytes = 150 * 1024 * 1024   # SDK_BINARY_MIN_BYTES

# ── sha512 helper (SRI base64 form, same value npm enforces) ─────────────────
function Get-Sri512([string]$path) {
  $sha = [System.Security.Cryptography.SHA512]::Create()
  $fs = [System.IO.File]::OpenRead($path)
  try { $hash = $sha.ComputeHash($fs) } finally { $fs.Dispose(); $sha.Dispose() }
  return "sha512-" + [Convert]::ToBase64String($hash)
}

# ── Idempotency: a valid existing seed is left untouched ─────────────────────
if (-not $Force -and (Test-Path $destBin) -and (Test-Path $marker)) {
  $curSize = (Get-Item $destBin).Length
  try {
    $mk = Get-Content $marker -Raw | ConvertFrom-Json
    if ($mk.sdkVersion -eq $Version -and [int64]$mk.size -eq $curSize -and $curSize -ge $minBytes) {
      Say "Already seeded and verified — nothing to do"
      Write-Host ("  binary : {0}`n  size   : {1} bytes`n  marker : {2}" -f $destBin, $curSize, $marker)
      exit 0
    }
  } catch { }
  Say "Existing seed failed the marker/size check — re-seeding"
}

$tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("hps-sdk-" + [Guid]::NewGuid().ToString("N"))) -Force
try {
  # ── Obtain the tarball ──────────────────────────────────────────────────────
  if ($Tarball) {
    if (-not (Test-Path $Tarball)) { Fail "Tarball not found: $Tarball" }
    Say "Using local tarball (air-gapped mode): $Tarball"
    $tgz = $Tarball
  } else {
    Say "Downloading $pkg@$Version (~67 MiB) from the npm registry"
    $tgz = Join-Path $tmp.FullName "sdk.tgz"
    Invoke-WebRequest -Uri $tgzUrl -OutFile $tgz -UseBasicParsing
  }

  # ── Verify sha512 ───────────────────────────────────────────────────────────
  Say "Verifying sha512"
  $actualSha = Get-Sri512 $tgz
  if ($actualSha -ne $expectedSha) {
    Fail "sha512 mismatch for $tgz`n  expected: $expectedSha`n  actual:   $actualSha`nRefusing to install. (Corrupt download? Wrong -Version/-Tarball?)"
  }
  Write-Host "  ok: $actualSha"

  # ── Extract + install ───────────────────────────────────────────────────────
  Say "Extracting package/claude.exe"
  # Use the Windows-native bsdtar explicitly (System32\tar.exe). A bare `tar`
  # can resolve to Git's GNU tar on PATH, which misreads a "C:\…" dest as a
  # remote host ("Cannot connect to C: resolve failed"). bsdtar handles the
  # Windows path fine. Ships with Windows 10 1803+.
  $sysTar = Join-Path $env:SystemRoot "System32\tar.exe"
  if (-not (Test-Path $sysTar)) { $sysTar = "tar.exe" }  # fallback: hope PATH has bsdtar
  & $sysTar -xzf $tgz -C $tmp.FullName "package/claude.exe"
  $extracted = Join-Path $tmp.FullName "package\claude.exe"
  if (-not (Test-Path $extracted)) { Fail "Tarball did not contain package/claude.exe" }
  $binSize = (Get-Item $extracted).Length
  if ($binSize -lt $minBytes) {
    Fail "Extracted claude.exe is only $binSize bytes (< ${minBytes} floor) — the runtime would reject it. Corrupt tarball?"
  }
  New-Item -ItemType Directory -Path $destDir -Force | Out-Null
  Move-Item -Force $extracted $destBin

  # ── Write the runtime-trusted marker (isSeededBinaryTrusted contract) ───────
  $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  $markerObj = [ordered]@{
    sdkVersion    = $Version
    size          = $binSize
    tarballSha512 = $expectedSha
    verifiedAt    = $now
    seededBy      = "scripts/seed-sdk-binary.ps1"
  }
  # BOM-less UTF-8, deliberately NOT `Out-File -Encoding utf8`: under Windows
  # PowerShell 5.1 (what venue machines run) that always emits EF BB BF, and the
  # extension reads this marker with fs.readFileSync(…, "utf8") + JSON.parse,
  # which throws on a leading BOM. isSeededBinaryTrusted then rejected a
  # perfectly good seed and Studio silently fell back to the proxy-only runtime.
  # The runtime now strips a BOM too (parseSdkBinaryMarker), so old seeds heal on
  # update — but write it clean here. PS 7's `-Encoding utf8NoBOM` does not exist
  # in 5.1, hence the .NET call.
  $json = $markerObj | ConvertTo-Json
  [System.IO.File]::WriteAllText($marker, $json, (New-Object System.Text.UTF8Encoding($false)))

  # ── Verification printout ───────────────────────────────────────────────────
  Say "Seeded successfully"
  Write-Host ("  binary : {0}" -f $destBin)
  Write-Host ("  size   : {0} bytes" -f $binSize)
  Write-Host ("  sha512 : {0} (tarball, verified)" -f $actualSha)
  Write-Host ("  marker : {0}" -f $marker)
  try {
    $v = & $destBin --version 2>$null | Select-Object -First 1
    if ($v) { Write-Host ("  launch : {0}" -f $v) }
    else    { Write-Host "  launch : (skipped — binary did not answer --version here; Studio verifies at runtime)" }
  } catch {
    Write-Host "  launch : (skipped — binary did not answer --version here; Studio verifies at runtime)"
  }
  # The native `claude --version` probe above may set a non-zero $LASTEXITCODE;
  # the seed itself succeeded, so exit clean (0) for callers/CI.
  exit 0
}
finally {
  Remove-Item -Recurse -Force $tmp.FullName -ErrorAction SilentlyContinue
}

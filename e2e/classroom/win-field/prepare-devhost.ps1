<#
.SYNOPSIS
  Remote classroom operations (#751) - Windows venue PC: put the CURRENT extension build into a COPY of an official
  HypeProof Studio shell, verify it, and (optionally) open it against a NON-production Service.

.DESCRIPTION
  Windows counterpart of e2e/classroom/mac-devhost.mjs. ASCII only (run with -File; see scripts/verify-ps1-encoding.sh).
    - The installed app is only READ. All work happens on a copy under -WorkDir, with its own user-data and extensions dirs.
    - The bundle is the CI artifact `classroom-field-bundle` (e2e/classroom/field-bundle.mjs). Every file is checked against
      the bundle's manifest.json before and after the copy. A bundle built from a dirty tree is refused unless -AllowDirty.
    - The shell's own Agent SDK JS tree (dist\vendor) is kept. The native claude.exe is NOT part of this: seed it with
      scripts\seed-sdk-binary.ps1 (preflight.ps1 reports whether it is there).
    - -ServiceUrl must not be a production host. This script never writes a token anywhere.
  What a run of this is NOT: an installed release, the updater, signing, or the installer path. Record it as
  "isolated dev host (official shell vX copy + extension <sha>)" together with the manifest it writes.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File prepare-devhost.ps1 -ShellDir "$env:LOCALAPPDATA\Programs\HypeProof Studio" -Bundle C:\hps\classroom-field-bundle -WorkDir C:\hps\devhost -ServiceUrl https://hypeproof-studio-api-staging.example.workers.dev/v1 -Launch
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File prepare-devhost.ps1 -SelfTest -Bundle C:\hps\classroom-field-bundle     # CI: exercises every refusal on a fake shell
#>
[CmdletBinding()]
param(
  [string]$ShellDir,
  [string]$Bundle,
  [string]$WorkDir,
  [string]$ServiceUrl,
  [switch]$Launch,
  [switch]$AllowDirty,
  [switch]$SelfTest
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Fail([string]$Message) { throw "prepare-devhost: $Message" }
function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Test-Inside([string]$Child, [string]$Parent) {
  $c = [System.IO.Path]::GetFullPath($Child).TrimEnd('\') + '\'
  $p = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  return $c.StartsWith($p, [System.StringComparison]::OrdinalIgnoreCase)
}

function Invoke-Prepare([string]$ShellDir, [string]$Bundle, [string]$WorkDir, [string]$ServiceUrl, [bool]$AllowDirty) {
  if (-not $ShellDir -or -not $Bundle -or -not $WorkDir -or -not $ServiceUrl) { Fail '-ShellDir, -Bundle, -WorkDir and -ServiceUrl are required' }
  $product = Join-Path $ShellDir 'resources\app\product.json'
  if (-not (Test-Path -LiteralPath $product)) { Fail "no Studio shell at $ShellDir (resources\app\product.json not found)" }
  if (Test-Inside $WorkDir $ShellDir) { Fail 'the working copy must not live inside the shell it copies' }
  foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, (Join-Path $env:LOCALAPPDATA 'Programs'))) {
    if ($root -and (Test-Inside $WorkDir $root)) { Fail "the working copy must not live under $root (that is where installed apps live)" }
  }
  $uri = $null
  if (-not [System.Uri]::TryCreate($ServiceUrl, [System.UriKind]::Absolute, [ref]$uri)) { Fail '-ServiceUrl is not a URL' }
  if ($uri.Host -match '(^|\.)hypeproof-ai\.xyz$') { Fail "-ServiceUrl is a PRODUCTION host ($($uri.Host)); a dev host copy only ever talks to staging or a local Service" }
  if ($uri.Scheme -ne 'https' -and $uri.Host -ne '127.0.0.1' -and $uri.Host -ne 'localhost') { Fail '-ServiceUrl must be https (or a local Service)' }

  $manifestPath = Join-Path $Bundle 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) { Fail "no manifest.json in $Bundle (unzip the classroom-field-bundle artifact first)" }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($manifest.schema -ne 'hps-classroom-field-bundle/1') { Fail "unknown bundle schema $($manifest.schema)" }
  if ($manifest.source_dirty -and -not $AllowDirty) { Fail 'this bundle was built from uncommitted changes; it is not field evidence (use -AllowDirty only for a developer check)' }
  $files = @($manifest.files.PSObject.Properties)
  if ($files.Count -lt 4) { Fail 'the bundle lists too few files' }
  foreach ($f in $files) {
    if ($f.Name -match '(^|/)\.\.(/|$)' -or $f.Name -match '^[/\\]' -or $f.Name -match ':') { Fail "unsafe path in the bundle manifest: $($f.Name)" }
    $src = Join-Path (Join-Path $Bundle 'extension') ($f.Name -replace '/', '\')
    if (-not (Test-Path -LiteralPath $src)) { Fail "bundle file missing: $($f.Name)" }
    if ((Get-Sha256 $src) -ne $f.Value) { Fail "bundle file does not match its manifest: $($f.Name)" }
  }

  $copy = Join-Path $WorkDir 'Studio'
  if (Test-Path -LiteralPath $copy) { Remove-Item -LiteralPath $copy -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
  Copy-Item -LiteralPath $ShellDir -Destination $copy -Recurse
  $ext = Join-Path $copy 'resources\app\extensions\hypeproof-chat'
  if (-not (Test-Path -LiteralPath (Join-Path $ext 'package.json'))) { Fail 'the shell has no built-in hypeproof-chat extension; this is not a HypeProof Studio release' }
  $shipped = Get-Content -LiteralPath (Join-Path $ext 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($f in $files) {
    $dst = Join-Path $ext ($f.Name -replace '/', '\')
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Copy-Item -LiteralPath (Join-Path (Join-Path $Bundle 'extension') ($f.Name -replace '/', '\')) -Destination $dst -Force
  }
  # The shell keeps ITS version (the updater and the branding check read it); everything else is the current manifest.
  $pkgPath = Join-Path $ext 'package.json'
  $pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $pkg.version = $shipped.version
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($pkgPath, ($pkg | ConvertTo-Json -Depth 64), $utf8)
  foreach ($f in $files) {
    if ($f.Name -eq 'package.json') { continue }
    if ((Get-Sha256 (Join-Path $ext ($f.Name -replace '/', '\'))) -ne $f.Value) { Fail "after the copy, $($f.Name) is not the bundle's file" }
  }
  $have = @($pkg.contributes.commands | ForEach-Object { $_.command })
  foreach ($c in @($manifest.commands_required)) { if ($have -notcontains $c) { Fail "the injected manifest does not declare $c" } }

  $userData = Join-Path $WorkDir 'user-data'
  New-Item -ItemType Directory -Force -Path (Join-Path $userData 'User') | Out-Null
  $settings = @{ 'hypeproofChat.proxyUrl' = $ServiceUrl; 'update.mode' = 'none'; 'telemetry.telemetryLevel' = 'off' }
  [System.IO.File]::WriteAllText((Join-Path $userData 'User\settings.json'), ($settings | ConvertTo-Json), $utf8)

  $shell = Get-Content -LiteralPath (Join-Path $copy 'resources\app\product.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $sdkJs = Join-Path $ext 'dist\vendor\node_modules\@anthropic-ai\claude-agent-sdk\package.json'
  $sdkShipped = $null
  if (Test-Path -LiteralPath $sdkJs) { $sdkShipped = (Get-Content -LiteralPath $sdkJs -Raw -Encoding UTF8 | ConvertFrom-Json).version }
  $result = [ordered]@{
    schema = 'hps-classroom-devhost-win/1'; prepared_at = (Get-Date).ToUniversalTime().ToString('o')
    what_this_is = 'CURRENT extension + webview build inside a COPY of an official Studio shell, isolated user data'
    what_this_is_not = @('the installed app', 'a release build of this branch', 'evidence about updater, signing, installer or shell patches')
    shell = [ordered]@{ copied_from = $ShellDir; version = $shell.version; commit = $shell.commit }
    extension = [ordered]@{ source_sha = $manifest.source_sha; source_dirty = [bool]$manifest.source_dirty; files = $manifest.files }
    agent_sdk = [ordered]@{ js_in_shell = $sdkShipped; pinned_by_source = $manifest.agent_sdk_pinned; same = ($sdkShipped -eq $manifest.agent_sdk_pinned) }
    service = $uri.GetLeftPart([System.UriPartial]::Authority)
    isolation = [ordered]@{ user_data_dir = $userData; extensions_dir = (Join-Path $WorkDir 'extensions') }
  }
  [System.IO.File]::WriteAllText((Join-Path $WorkDir 'manifest.json'), ($result | ConvertTo-Json -Depth 8), $utf8)
  Write-Host "prepared: $copy"
  Write-Host "  shell $($shell.version) (copy) - extension source $($manifest.source_sha.Substring(0,7)) - $($files.Count) files verified"
  if (-not $result.agent_sdk.same) { Write-Warning "Agent SDK JS in this shell is $sdkShipped, the source pins $($manifest.agent_sdk_pinned): SDK behaviour seen here is the SHELL's SDK, write that down" }
  return $result
}

function Invoke-SelfTest([string]$Bundle) {
  if (-not $Bundle) { Fail '-SelfTest needs -Bundle (a real field bundle directory)' }
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('hps-devhost-selftest-' + [System.Guid]::NewGuid().ToString('N'))
  $shell = Join-Path $tmp 'fake-shell'; $ext = Join-Path $shell 'resources\app\extensions\hypeproof-chat'
  New-Item -ItemType Directory -Force -Path (Join-Path $ext 'dist\vendor\node_modules\@anthropic-ai\claude-agent-sdk') | Out-Null
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText((Join-Path $shell 'resources\app\product.json'), '{"version":"0.0.1-selftest","commit":"fake"}', $utf8)
  [System.IO.File]::WriteAllText((Join-Path $ext 'package.json'), '{"name":"hypeproof-chat","version":"0.0.1-selftest","contributes":{"commands":[]}}', $utf8)
  [System.IO.File]::WriteAllText((Join-Path $ext 'dist\extension.js'), 'old build', $utf8)
  [System.IO.File]::WriteAllText((Join-Path $ext 'dist\vendor\node_modules\@anthropic-ai\claude-agent-sdk\package.json'), '{"version":"0.0.0-shell"}', $utf8)
  $staging = 'https://hypeproof-studio-api-staging.example.workers.dev/v1'
  $passed = 0
  function Expect-Refusal([string]$Name, [scriptblock]$Action, [string]$Pattern) {
    try { & $Action | Out-Null } catch { if ($_.Exception.Message -match $Pattern) { Write-Host "PASS refuses: $Name"; return }; throw "selftest: '$Name' failed for another reason: $($_.Exception.Message)" }
    throw "selftest: '$Name' was NOT refused"
  }
  try {
    # positive control first: a good bundle into a fake shell
    $r = Invoke-Prepare $shell $Bundle (Join-Path $tmp 'work') $staging $true
    $injected = Join-Path $tmp 'work\Studio\resources\app\extensions\hypeproof-chat'
    $m = Get-Content -LiteralPath (Join-Path $Bundle 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ((Get-Sha256 (Join-Path $injected 'dist\extension.js')) -ne $m.files.'dist/extension.js') { throw 'selftest: extension.js was not replaced by the bundle build' }
    if ((Get-Content -LiteralPath (Join-Path $injected 'package.json') -Raw | ConvertFrom-Json).version -ne '0.0.1-selftest') { throw 'selftest: the shell version was not kept' }
    if (-not (Test-Path -LiteralPath (Join-Path $injected 'dist\vendor\node_modules\@anthropic-ai\claude-agent-sdk\package.json'))) { throw 'selftest: the shell SDK tree was removed' }
    if ((Get-Content -LiteralPath (Join-Path $shell 'resources\app\extensions\hypeproof-chat\dist\extension.js') -Raw) -ne 'old build') { throw 'selftest: the SOURCE shell was modified' }
    if ($r.agent_sdk.same) { throw 'selftest: an SDK version mismatch must be reported' }
    Write-Host 'PASS prepares a copy, keeps the shell version and SDK tree, leaves the source shell untouched'; $passed++
    Expect-Refusal 'production Service' { Invoke-Prepare $shell $Bundle (Join-Path $tmp 'w2') 'https://api.hypeproof-ai.xyz/v1' $true } 'PRODUCTION host'; $passed++
    Expect-Refusal 'plain http Service' { Invoke-Prepare $shell $Bundle (Join-Path $tmp 'w3') 'http://staging.example.net/v1' $true } 'must be https'; $passed++
    Expect-Refusal 'work dir inside the shell' { Invoke-Prepare $shell $Bundle (Join-Path $shell 'work') $staging $true } 'inside the shell'; $passed++
    if ($env:ProgramFiles) { Expect-Refusal 'work dir under Program Files' { Invoke-Prepare $shell $Bundle (Join-Path $env:ProgramFiles 'hps-selftest-never-created') $staging $true } 'installed apps live'; $passed++ }
    $bad = Join-Path $tmp 'tampered'; Copy-Item -LiteralPath $Bundle -Destination $bad -Recurse
    Add-Content -LiteralPath (Join-Path $bad 'extension\dist\extension.js') -Value '// tampered'
    Expect-Refusal 'tampered bundle' { Invoke-Prepare $shell $bad (Join-Path $tmp 'w4') $staging $true } 'does not match its manifest'; $passed++
    $dirty = Join-Path $tmp 'dirty'; Copy-Item -LiteralPath $Bundle -Destination $dirty -Recurse
    $dm = Get-Content -LiteralPath (Join-Path $dirty 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json; $dm.source_dirty = $true
    [System.IO.File]::WriteAllText((Join-Path $dirty 'manifest.json'), ($dm | ConvertTo-Json -Depth 8), $utf8)
    Expect-Refusal 'bundle from a dirty tree' { Invoke-Prepare $shell $dirty (Join-Path $tmp 'w5') $staging $false } 'uncommitted changes'; $passed++
    Expect-Refusal 'not a Studio shell' { Invoke-Prepare (Join-Path $tmp 'nothing-here') $Bundle (Join-Path $tmp 'w6') $staging $true } 'no Studio shell'; $passed++
    Write-Host "$passed prepare-devhost self-test checks passed (fake shell; says nothing about a real Studio window)"
  } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($SelfTest) { Invoke-SelfTest $Bundle; exit 0 }
$prepared = Invoke-Prepare $ShellDir $Bundle $WorkDir $ServiceUrl ([bool]$AllowDirty)
if ($Launch) {
  $exe = Get-ChildItem -LiteralPath (Join-Path $WorkDir 'Studio') -Filter '*.exe' | Where-Object { $_.Name -notmatch 'unins|tunnel|server' } | Select-Object -First 1
  if (-not $exe) { Fail 'no Studio executable in the copy' }
  Write-Host "opening $($exe.FullName) against $($prepared.service) - the learner token is typed in the app, never passed here"
  Start-Process -FilePath $exe.FullName -ArgumentList @('--user-data-dir', "`"$($prepared.isolation.user_data_dir)`"", '--extensions-dir', "`"$($prepared.isolation.extensions_dir)`"", '--disable-updates', '--new-window')
}

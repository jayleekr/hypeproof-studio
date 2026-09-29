<#
.SYNOPSIS
  Remote classroom operations (#751) - Windows venue PC preflight. Reads only; changes nothing; sends no token.

.DESCRIPTION
  Run on EACH venue PC 30+ minutes before class, on the venue network. ASCII only (run with -File).
  It answers the questions that stopped real classes before:
    - can this PC reach the Service at all, over TLS that is not being re-signed by a school proxy?
    - is the clock close enough to the Service's that a freshly issued token is not "expired"?
    - is the Agent SDK native binary seeded where the app looks for it (else every turn silently falls back to proxy)?
    - is there room on disk, and is the prepared copy the build we think it is?
  Output: a table on screen and preflight.json next to the prepared copy (no secrets in it). Exit 0 = no FAIL rows.
  A WARN row is a thing to write into the class log, not a reason to cancel.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File preflight.ps1 -WorkDir C:\hps\devhost
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File preflight.ps1 -SelfTest          # CI: the pure checks, no network
#>
[CmdletBinding()]
param(
  [string]$WorkDir,
  [int]$MaxClockSkewSeconds = 120,
  [int]$MinFreeGb = 5,
  [switch]$SelfTest
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function New-Row([string]$Check, [string]$Status, [string]$Detail) { return [pscustomobject]@{ check = $Check; status = $Status; detail = $Detail } }
function Get-SkewStatus([double]$SkewSeconds, [int]$Max) { if ([math]::Abs($SkewSeconds) -le $Max) { return 'PASS' }; return 'FAIL' }
function Get-IssuerStatus([string]$Issuer) {
  # A school or corporate TLS inspector re-signs the certificate: the chain then ends in the organisation's own CA.
  if ($Issuer -match "Let's Encrypt|Google Trust Services|Cloudflare|DigiCert|Sectigo|GlobalSign|Amazon|ISRG|Baltimore") { return 'PASS' }
  return 'WARN'
}

if ($SelfTest) {
  $n = 0
  if ((Get-SkewStatus 30 120) -ne 'PASS') { throw 'selftest: 30 s skew must pass' }; $n++
  if ((Get-SkewStatus -400 120) -ne 'FAIL') { throw 'selftest: a clock 400 s behind must fail' }; $n++
  if ((Get-IssuerStatus 'CN=WE1, O=Google Trust Services, C=US') -ne 'PASS') { throw 'selftest: a public CA must pass' }; $n++
  if ((Get-IssuerStatus 'CN=School-Proxy-Root-CA, O=Some School') -ne 'WARN') { throw 'selftest: an organisation CA must be flagged' }; $n++
  Write-Host "$n preflight self-test checks passed (pure checks only; no network, no venue)"
  exit 0
}

if (-not $WorkDir) { throw 'preflight: -WorkDir (the directory prepare-devhost.ps1 wrote) is required' }
$manifestPath = Join-Path $WorkDir 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "preflight: no manifest.json in $WorkDir - run prepare-devhost.ps1 first" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$rows = @()
$rows += New-Row 'prepared copy' 'INFO' "shell $($manifest.shell.version) + extension $($manifest.extension.source_sha.Substring(0,7)); SDK JS $($manifest.agent_sdk.js_in_shell) (source pins $($manifest.agent_sdk.pinned_by_source))"

$os = Get-CimInstance Win32_OperatingSystem
$rows += New-Row 'windows' 'INFO' "$($os.Caption) $($os.Version) $($env:PROCESSOR_ARCHITECTURE)"

$drive = (Get-Item -LiteralPath $WorkDir).PSDrive
$freeGb = [math]::Round($drive.Free / 1GB, 1)
$diskStatus = 'PASS'; if ($freeGb -lt $MinFreeGb) { $diskStatus = 'FAIL' }
$rows += New-Row 'free disk' $diskStatus "$freeGb GB free on $($drive.Name): (need $MinFreeGb)"

# The app resolves %APPDATA%\HypeProof-Studio\sdk\<version>\claude.exe (scripts\seed-sdk-binary.ps1 writes it).
$sdkRoot = Join-Path $env:APPDATA 'HypeProof-Studio\sdk'
$seeded = @(); if (Test-Path -LiteralPath $sdkRoot) { $seeded = @(Get-ChildItem -LiteralPath $sdkRoot -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'claude.exe') } | ForEach-Object { $_.Name }) }
$want = $manifest.agent_sdk.js_in_shell
if ($seeded -contains $want) { $rows += New-Row 'SDK native binary' 'PASS' "seeded for $want" }
elseif ($seeded.Count -gt 0) { $rows += New-Row 'SDK native binary' 'WARN' "seeded for $($seeded -join ', ') but the shell's SDK JS is $want - turns will fall back to the proxy runtime; seed $want" }
else { $rows += New-Row 'SDK native binary' 'WARN' 'not seeded - every turn falls back to the proxy runtime (stop/reset of an SDK run cannot be shown on this PC); run scripts\seed-sdk-binary.ps1' }

$service = [System.Uri]$manifest.service
if ($service.Scheme -ne 'https') { $rows += New-Row 'TLS issuer' 'INFO' 'local Service over http - nothing to inspect' }
else { try {
  $tcp = New-Object System.Net.Sockets.TcpClient
  $tcp.Connect($service.Host, 443)
  $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false)
  $ssl.AuthenticateAsClient($service.Host)
  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($ssl.RemoteCertificate)
  $rows += New-Row 'TLS issuer' (Get-IssuerStatus $cert.Issuer) "$($cert.Issuer) - WARN means the network re-signs TLS (inspection proxy): expect SDK/streaming failures, test one full turn before class"
  $ssl.Dispose(); $tcp.Close()
} catch { $rows += New-Row 'TLS issuer' 'FAIL' "cannot open TLS to $($service.Host):443 - $($_.Exception.Message)" } }

try {
  $before = [DateTimeOffset]::UtcNow
  $resp = Invoke-WebRequest -Uri ($manifest.service + '/v1/health') -UseBasicParsing -TimeoutSec 15
  $after = [DateTimeOffset]::UtcNow
  $rows += New-Row 'service /v1/health' 'PASS' "HTTP $($resp.StatusCode) in $([int]($after - $before).TotalMilliseconds) ms"
  $serverDate = [DateTimeOffset]::Parse($resp.Headers['Date'])
  $skew = ($before.AddMilliseconds(($after - $before).TotalMilliseconds / 2) - $serverDate).TotalSeconds
  $rows += New-Row 'clock skew' (Get-SkewStatus $skew $MaxClockSkewSeconds) "$([int]$skew) s against the Service (limit $MaxClockSkewSeconds) - a wrong clock makes a fresh token look expired"
} catch { $rows += New-Row 'service /v1/health' 'FAIL' "$($manifest.service)/v1/health - $($_.Exception.Message)" }

$rows | Format-Table -AutoSize -Wrap | Out-String | Write-Host
$failed = @($rows | Where-Object { $_.status -eq 'FAIL' })
$utf8 = New-Object System.Text.UTF8Encoding($false)
$report = [ordered]@{ schema = 'hps-classroom-preflight-win/1'; at = (Get-Date).ToUniversalTime().ToString('o'); computer = $env:COMPUTERNAME; rows = $rows; verdict = $(if ($failed.Count) { 'FAIL' } else { 'OK_TO_TRY' }) }
[System.IO.File]::WriteAllText((Join-Path $WorkDir 'preflight.json'), ($report | ConvertTo-Json -Depth 6), $utf8)
Write-Host "verdict: $($report.verdict) -> $(Join-Path $WorkDir 'preflight.json') (no token or learner data in it)"
if ($failed.Count) { exit 1 }

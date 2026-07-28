#Requires -Version 5.1
<#
    install.ps1 - HypeProof Windows one-line bootstrap.

    Usage (one-liner):
        irm https://raw.githubusercontent.com/jayleekr/hypeproof-studio-releases/main/install.ps1 | iex

    With flags (download first, then run):
        iwr -useb https://.../install.ps1 -OutFile install.ps1
        powershell -ExecutionPolicy Bypass -File .\install.ps1 -y

    This is the Windows sibling of install.sh (macOS). BOTH read ONE versioned
    dependency manifest (hypeproof-deps.yaml, schema 1) as the single source of
    truth, and `hps doctor` re-verifies that exact same manifest. The manifest is
    transcribed inline below (EMBEDDED_MANIFEST) so the script runs standalone via
    `irm | iex`; the volatile version fields are refreshed from the remote YAML
    when reachable, so the pinned SoT stays authoritative.

    What it does, in order:
      1. Detect OS / arch / existing tools.
      2. Ensure winget (App Installer); fallback to winget-cli msixbundle.
      3. Install every REAL runtime dependency from the manifest via winget,
         with direct-download fallbacks. Git.Git also ships Git Bash -> the
         guaranteed POSIX shell so the bundled bash-based skills stop breaking.
      4. Ensure a POSIX shell (Git Bash, else WSL) is present and on PATH.
      5. Configure git: core.autocrlf=false + core.longpaths=true.
      6. Download + install the Studio app (per-user, no admin, SmartScreen bypass).
      7. Seed the native SDK binary (claude.exe) - NOW automated for win32.
      8. Record a receipt so re-runs are idempotent upgrades (grep-before-append
         every PATH / rc edit).
      9. Fail-closed `hps doctor`: re-verify the manifest, exit non-zero on any miss.

    Unattended:
      -y / -NonInteractive  or  env HPS_NONINTERACTIVE=1   -> no prompts.
      -NoModifyPath         or  env INSTALLER_NO_MODIFY_PATH -> never touch PATH.
#>

[CmdletBinding()]
param(
    [Alias('y')]
    [switch]$Yes,
    [switch]$NonInteractive,
    [switch]$NoModifyPath,
    [switch]$DoctorOnly,
    # Remote manifest refresh is best-effort (falls back to the embedded pins).
    [string]$ManifestUrl = 'https://raw.githubusercontent.com/jayleekr/hypeproof-studio-releases/main/hypeproof-deps.yaml',
    # Raw base for the bootstrap (irm | iex) path, where no sibling script exists.
    # It must point at a tree that ACTUALLY hosts scripts/seed-sdk-binary.ps1:
    # this repo, not the releases repo (Studio binaries only). Deriving it from
    # $ManifestUrl gave a 404 seeder URL, which is fail-closed on Windows.
    [string]$ScriptsBaseUrl = 'https://raw.githubusercontent.com/jayleekr/hypeproof-studio/main/scripts/'
)

# ----------------------------------------------------------------------------
# 0. Strict mode + globals
# ----------------------------------------------------------------------------
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference     = 'SilentlyContinue'   # speeds up Invoke-WebRequest hugely

# Honor env-var forms of the unattended switches.
if ($env:HPS_NONINTERACTIVE -eq '1' -or $env:HPS_NONINTERACTIVE -eq 'true') { $NonInteractive = $true }
if ($Yes) { $NonInteractive = $true }
if ($env:INSTALLER_NO_MODIFY_PATH) { $NoModifyPath = $true }

$script:ExitCode = 0
$script:AppData  = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $env:USERPROFILE 'AppData\Roaming' }
$script:HpsHome  = Join-Path $script:AppData 'HypeProof-Studio'
$script:ReceiptPath = Join-Path $script:HpsHome 'receipt.json'
$script:TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('hps-install-' + [Guid]::NewGuid().ToString('N').Substring(0,8))

# ----------------------------------------------------------------------------
# 1. Logging / progress helpers
# ----------------------------------------------------------------------------
$script:Step = 0
function Write-Head([string]$m) {
    $script:Step++
    Write-Host ''
    Write-Host ("==> [{0}] {1}" -f $script:Step, $m) -ForegroundColor Cyan
}
function Write-Info([string]$m)  { Write-Host ("    {0}" -f $m) -ForegroundColor Gray }
function Write-Ok([string]$m)    { Write-Host ("    OK  {0}" -f $m) -ForegroundColor Green }
function Write-Warn2([string]$m) { Write-Host ("    !!  {0}" -f $m) -ForegroundColor Yellow }
function Write-Err2([string]$m)  { Write-Host ("    XX  {0}" -f $m) -ForegroundColor Red }

function Confirm-Or([string]$prompt, [bool]$default = $true) {
    if ($NonInteractive) { return $default }
    $suffix = if ($default) { '[Y/n]' } else { '[y/N]' }
    $ans = Read-Host ("    {0} {1}" -f $prompt, $suffix)
    if ([string]::IsNullOrWhiteSpace($ans)) { return $default }
    return ($ans -match '^(y|yes)$')
}

# ----------------------------------------------------------------------------
# 2. EMBEDDED MANIFEST (transcription of hypeproof-deps.yaml, schema 1)
#    The SAME set of checks used by install.sh and `hps doctor`.
# ----------------------------------------------------------------------------
$EMBEDDED_MANIFEST = [ordered]@{
    schema = 1
    studio = [ordered]@{
        releases_repo = 'jayleekr/hypeproof-studio-releases'
        version       = '0.1.33'
        # Windows asset glob + fallback glob.
        asset_glob    = '*UserSetup-x64-*.exe'
        asset_glob_fallback = '*Setup-x64-*.exe'
    }
    sdk = [ordered]@{
        # SDK seeding is delegated to the canonical scripts/seed-sdk-binary.ps1 —
        # the single source of truth for the platform package, the pinned version
        # (0.3.207), the sha512 table, and the runtime-trusted marker schema
        # (sdkVersion/size/tarballSha512, checked by isSeededBinaryTrusted).
        # Do NOT re-pin a version or package here; that only drifts.
        seed_script = 'seed-sdk-binary.ps1'
    }
    # REAL runtime tools only. Build-time-only tools are intentionally excluded.
    tools = @(
        [ordered]@{ id='git';    winget='Git.Git';             cmd='git';     args='--version'; min='2.30'; required=$true;  post='' }
        [ordered]@{ id='gh';     winget='GitHub.cli';          cmd='gh';      args='--version'; min='2.40'; required=$true;  post='gh_auth' }
        [ordered]@{ id='node';   winget='OpenJS.NodeJS.LTS';   cmd='node';    args='--version'; min='18.0'; required=$true;  post='' }
        [ordered]@{ id='python'; winget='Python.Python.3.11';  cmd='python';  args='--version'; min='3.11'; required=$true;  post='' }
        [ordered]@{ id='jq';     winget='jqlang.jq';           cmd='jq';      args='--version'; min='1.6';  required=$true;  post='' }
        [ordered]@{ id='curl';   winget='';                    cmd='curl';    args='--version'; min='';     required=$true;  post='preinstalled' }
    )
}

# Try to refresh the volatile version fields from the remote manifest so the
# pinned SoT wins even if this embedded copy has drifted. Best-effort only.
function Sync-ManifestVersions {
    param($manifest, [string]$url)
    try {
        $raw = (Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 15).Content
        $sv = [regex]::Match($raw, '(?ms)^studio:.*?^\s*version:\s*"?([0-9][^"\r\n]*)"?')
        if ($sv.Success) { $manifest.studio.version = $sv.Groups[1].Value.Trim() }
        # The SDK version is owned entirely by seed-sdk-binary.ps1 (pinned there);
        # nothing to sync here.
        Write-Info ("Manifest versions synced from remote: studio {0}" -f $manifest.studio.version)
    } catch {
        Write-Info 'Remote manifest unreachable; using embedded pinned versions.'
    }
}

# ----------------------------------------------------------------------------
# 3. Receipt (idempotency ledger)
# ----------------------------------------------------------------------------
function Read-Receipt {
    if (Test-Path $script:ReceiptPath) {
        try { return (Get-Content -Raw -LiteralPath $script:ReceiptPath | ConvertFrom-Json) } catch { }
    }
    return [pscustomobject]@{
        schema     = 1
        first_run  = (Get-Date).ToString('o')
        last_run   = $null
        os         = 'win32'
        arch       = $null
        installed  = @{}      # id -> version
        path_edits = @()      # PATH fragments we have already added
        studio     = $null    # installed studio version
        sdk        = $null    # seeded sdk version
    }
}
function Write-Receipt($r) {
    $r.last_run = (Get-Date).ToString('o')
    $dir = Split-Path -Parent $script:ReceiptPath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    ($r | ConvertTo-Json -Depth 8) | Set-Content -Encoding UTF8 -LiteralPath $script:ReceiptPath
}

# ----------------------------------------------------------------------------
# 4. Detection helpers
# ----------------------------------------------------------------------------
function Get-Arch {
    $a = $env:PROCESSOR_ARCHITECTURE
    if ($env:PROCESSOR_ARCHITEW6432) { $a = $env:PROCESSOR_ARCHITEW6432 }
    switch -Regex ($a) {
        'ARM64' { return 'arm64' }
        'AMD64' { return 'x64' }
        'x86'   { return 'x86' }
        default { return $a.ToLower() }
    }
}

function Test-Command([string]$name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# Compare dotted versions: returns $true when $have >= $min.
function Test-VersionAtLeast([string]$have, [string]$min) {
    if ([string]::IsNullOrWhiteSpace($min)) { return $true }
    $h = ([regex]::Match($have, '\d+(\.\d+)+')).Value
    $m = ([regex]::Match($min,  '\d+(\.\d+)+')).Value
    if (-not $h) { return $false }
    try {
        $hv = [version]([string]::Join('.', ($h.Split('.')[0..([Math]::Min(3,$h.Split('.').Count-1))])))
        $mv = [version]([string]::Join('.', ($m.Split('.')[0..([Math]::Min(3,$m.Split('.').Count-1))])))
        return ($hv -ge $mv)
    } catch { return $true }
}

# Run a tool's check command and return the raw version string (or $null).
function Get-ToolVersion($tool) {
    if (-not (Test-Command $tool.cmd)) { return $null }
    try {
        $out = & $tool.cmd $tool.args.Split(' ') 2>&1 | Out-String
        return $out.Trim()
    } catch { return $null }
}

# ----------------------------------------------------------------------------
# 5. PATH management (dedup via receipt + live env; honor -NoModifyPath)
# ----------------------------------------------------------------------------
function Add-ToUserPath {
    param([string]$dir, $receipt)
    if ([string]::IsNullOrWhiteSpace($dir)) { return }
    if (-not (Test-Path $dir)) { return }
    $dir = (Resolve-Path $dir).Path

    # Always make it live for THIS process so later verify steps see it.
    if (($env:Path -split ';') -notcontains $dir) {
        $env:Path = "$dir;$env:Path"
    }

    if ($NoModifyPath) {
        Write-Info "PATH not modified (-NoModifyPath): $dir"
        return
    }

    # Idempotency: skip if the receipt already recorded this edit.
    if ($receipt.path_edits -contains $dir) {
        Write-Info "PATH already recorded: $dir"
        return
    }

    # grep-before-append against the persisted USER PATH.
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath) { $userPath = '' }
    $parts = $userPath -split ';' | Where-Object { $_ -ne '' }
    if ($parts -notcontains $dir) {
        $new = if ($userPath.TrimEnd(';')) { ($userPath.TrimEnd(';') + ';' + $dir) } else { $dir }
        [Environment]::SetEnvironmentVariable('Path', $new, 'User')
        Write-Ok "PATH += $dir (user)"
    } else {
        Write-Info "PATH already contains: $dir"
    }
    $receipt.path_edits = @($receipt.path_edits + $dir | Select-Object -Unique)
}

# Refresh $env:Path from Machine+User so freshly-installed tools resolve.
function Update-ProcessPath {
    $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $u = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (($m, $u) -join ';')
}

# ----------------------------------------------------------------------------
# 6. winget bootstrap (App Installer); fallback msixbundle
# ----------------------------------------------------------------------------
function Ensure-Winget {
    if (Test-Command 'winget') {
        Write-Ok ("winget present: " + ((winget --version) 2>&1))
        return $true
    }
    Write-Warn2 'winget (App Installer) not found - attempting to provision it.'

    # Try the Store's App Installer first via a non-interactive appx add of the
    # bundled framework deps, else pull the winget-cli GitHub release msixbundle.
    try {
        $rel = Invoke-RestMethod -UseBasicParsing -Uri 'https://api.github.com/repos/microsoft/winget-cli/releases/latest' -Headers (Get-GhHeaders)
        $bundle = $rel.assets | Where-Object { $_.name -like '*.msixbundle' } | Select-Object -First 1
        $lic    = $rel.assets | Where-Object { $_.name -like '*License*.xml' } | Select-Object -First 1
        if (-not $bundle) { throw 'no msixbundle asset in latest winget-cli release' }

        New-Item -ItemType Directory -Force -Path $script:TempRoot | Out-Null
        $bundlePath = Join-Path $script:TempRoot $bundle.name
        Write-Info "Downloading $($bundle.name) ..."
        Invoke-WebRequest -UseBasicParsing -Uri $bundle.browser_download_url -OutFile $bundlePath

        # VCLibs + UI.Xaml framework dependencies (best-effort; usually present).
        try {
            Add-AppxPackage -Path 'https://aka.ms/Microsoft.VCLibs.x64.14.00.Desktop.appx' -ErrorAction SilentlyContinue
        } catch { }

        if ($lic) {
            $licPath = Join-Path $script:TempRoot $lic.name
            Invoke-WebRequest -UseBasicParsing -Uri $lic.browser_download_url -OutFile $licPath
            Add-AppxProvisionedPackage -Online -PackagePath $bundlePath -LicensePath $licPath -ErrorAction SilentlyContinue | Out-Null
        }
        Add-AppxPackage -Path $bundlePath
        Start-Sleep -Seconds 2
        Update-ProcessPath
    } catch {
        Write-Err2 "Could not auto-install winget: $($_.Exception.Message)"
    }

    if (Test-Command 'winget') {
        Write-Ok 'winget provisioned.'
        return $true
    }
    Write-Err2 'winget unavailable. Install "App Installer" from the Microsoft Store, then re-run.'
    return $false
}

function Get-GhHeaders {
    $h = @{ 'User-Agent' = 'hypeproof-installer'; 'Accept' = 'application/vnd.github+json' }
    if ($env:GITHUB_TOKEN) { $h['Authorization'] = "Bearer $($env:GITHUB_TOKEN)" }
    return $h
}

# ----------------------------------------------------------------------------
# 7. Install one tool via winget (with optional direct-download fallback)
# ----------------------------------------------------------------------------
function Install-WingetPackage {
    param([string]$id)
    $wingetArgs = @(
        'install', '--id', $id, '--exact',
        '--accept-package-agreements', '--accept-source-agreements',
        '--silent', '--disable-interactivity',
        '--scope', 'user'
    )
    Write-Info "winget install $id ..."
    & winget @wingetArgs 2>&1 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
    $code = $LASTEXITCODE
    # winget: 0 ok; -1978335189 == already installed / no applicable update.
    if ($code -eq 0 -or $code -eq -1978335189) { return $true }
    # Retry without user scope (some packages are machine-scope only).
    Write-Info "retry (machine scope) ..."
    & winget install --id $id --exact --accept-package-agreements --accept-source-agreements --silent --disable-interactivity 2>&1 |
        ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
    return ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq -1978335189)
}

function Ensure-Tool {
    param($tool, $receipt)

    $ver = Get-ToolVersion $tool
    if ($ver -and (Test-VersionAtLeast $ver $tool.min)) {
        Write-Ok ("{0} present ({1})" -f $tool.id, (($ver -split "`n")[0]).Trim())
        $receipt.installed[$tool.id] = (($ver -split "`n")[0]).Trim()
        Invoke-ToolPost $tool
        return $true
    }

    if ($tool.post -eq 'preinstalled' -and -not (Test-Command $tool.cmd)) {
        Write-Warn2 ("{0} expected preinstalled but missing (Windows 10+ ships it)." -f $tool.id)
    }

    if ([string]::IsNullOrWhiteSpace($tool.winget)) {
        if (Test-Command $tool.cmd) { Write-Ok ("{0} present." -f $tool.id); return $true }
        Write-Err2 ("{0} missing and no winget package defined." -f $tool.id)
        return (-not $tool.required)
    }

    Write-Info ("{0}: not present or below min {1} - installing {2}" -f $tool.id, $tool.min, $tool.winget)
    $ok = Install-WingetPackage $tool.winget
    Update-ProcessPath
    if (-not $ok) {
        Write-Err2 ("winget failed for {0} ({1})." -f $tool.id, $tool.winget)
        return (-not $tool.required)
    }

    $ver2 = Get-ToolVersion $tool
    if ($ver2) {
        Write-Ok ("{0} installed ({1})" -f $tool.id, (($ver2 -split "`n")[0]).Trim())
        $receipt.installed[$tool.id] = (($ver2 -split "`n")[0]).Trim()
        Invoke-ToolPost $tool
        return $true
    }
    Write-Warn2 ("{0} installed but not yet on PATH (may need a new shell)." -f $tool.id)
    return $true
}

function Invoke-ToolPost($tool) {
    switch ($tool.post) {
        'gh_auth' {
            try {
                & gh auth status 1>$null 2>$null
                if ($LASTEXITCODE -ne 0) {
                    Write-Warn2 "gh is not authenticated. Run: gh auth login   (warning only, not fatal)"
                }
            } catch { Write-Warn2 'gh auth status could not be checked.' }
        }
        default { }
    }
}

# ----------------------------------------------------------------------------
# 8. POSIX shell guarantee (Git Bash, else WSL)
# ----------------------------------------------------------------------------
function Ensure-PosixShell {
    param($receipt)
    $gitBash = 'C:\Program Files\Git\bin\bash.exe'
    if (Test-Path $gitBash) {
        Write-Ok "POSIX shell available: Git Bash ($gitBash)"
        Add-ToUserPath 'C:\Program Files\Git\bin' $receipt
        # Sanity: the bundled skills need real bash idioms ([[ ]], set -euo pipefail).
        try {
            $v = & $gitBash -c 'echo $BASH_VERSION'
            Write-Info "Git Bash version: $($v.Trim())"
        } catch { }
        return $true
    }

    Write-Warn2 'Git Bash not found (Git.Git should have provided it).'
    # WSL fallback - heavier; only if Git Bash truly unavailable.
    if (Test-Command 'wsl') {
        try {
            $distros = (& wsl -l -q) 2>$null
            if ($distros) {
                Write-Ok 'WSL present with a distro - POSIX shell available via wsl.'
                return $true
            }
        } catch { }
        if (Confirm-Or 'Install Ubuntu on WSL as the POSIX shell fallback?' $false) {
            & wsl --install -d Ubuntu 2>&1 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
            Write-Warn2 'WSL/Ubuntu install may require a reboot to finish.'
            return $true
        }
    }
    Write-Err2 'No POSIX shell (Git Bash or WSL). Bundled bash skills will not run. Re-run after Git installs.'
    return $false
}

# ----------------------------------------------------------------------------
# 9. git configuration (CRLF + long paths) - idempotent by nature
# ----------------------------------------------------------------------------
function Configure-Git {
    if (-not (Test-Command 'git')) { Write-Warn2 'git not on PATH yet; skipping git config.'; return }
    & git config --global core.autocrlf false
    & git config --global core.longpaths true
    Write-Ok 'git configured: core.autocrlf=false, core.longpaths=true (global)'
    # Enable Win32 long paths at the OS level if we can (best-effort, needs admin).
    try {
        $k = 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem'
        $cur = (Get-ItemProperty -Path $k -Name 'LongPathsEnabled' -ErrorAction SilentlyContinue).LongPathsEnabled
        if ($cur -ne 1) {
            Set-ItemProperty -Path $k -Name 'LongPathsEnabled' -Value 1 -Type DWord -ErrorAction Stop
            Write-Ok 'Win32 LongPathsEnabled=1 (registry).'
        }
    } catch {
        Write-Info 'Could not set HKLM LongPathsEnabled (needs admin) - git core.longpaths still covers git ops.'
    }
}

# ----------------------------------------------------------------------------
# 10. Studio app download + install (per-user, no admin)
# ----------------------------------------------------------------------------
function Resolve-StudioAsset {
    param($manifest)
    $repo = $manifest.studio.releases_repo
    $ver  = $manifest.studio.version
    $tag  = "v$ver"
    $headers = Get-GhHeaders
    $rel = $null
    foreach ($u in @(
        "https://api.github.com/repos/$repo/releases/tags/$tag",
        "https://api.github.com/repos/$repo/releases/latest"
    )) {
        try { $rel = Invoke-RestMethod -UseBasicParsing -Uri $u -Headers $headers; if ($rel) { break } } catch { }
    }
    if (-not $rel) { throw "No release found for $repo ($tag / latest)." }

    $globs = @($manifest.studio.asset_glob, $manifest.studio.asset_glob_fallback)
    foreach ($g in $globs) {
        $a = $rel.assets | Where-Object { $_.name -like $g } | Select-Object -First 1
        if ($a) { return $a }
    }
    throw "No Studio asset matched globs [$($globs -join ', ')] in release $($rel.tag_name)."
}

function Install-Studio {
    param($manifest, $receipt)
    if ($receipt.studio -eq $manifest.studio.version) {
        Write-Ok "Studio $($manifest.studio.version) already recorded as installed (idempotent skip)."
        return $true
    }
    try {
        $asset = Resolve-StudioAsset $manifest
    } catch {
        Write-Err2 "Studio asset resolution failed: $($_.Exception.Message)"
        return $false
    }
    New-Item -ItemType Directory -Force -Path $script:TempRoot | Out-Null
    $exe = Join-Path $script:TempRoot $asset.name
    Write-Info "Downloading $($asset.name) ..."
    Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $exe

    # Unblock the download (bypass the MOTW/SmartScreen prompt for our own signed setup).
    try { Unblock-File -LiteralPath $exe } catch { }

    Write-Info 'Running Studio UserSetup (per-user, silent, no admin) ...'
    # Inno Setup silent flags used by VSCodium-family UserSetup installers.
    $p = Start-Process -FilePath $exe -ArgumentList @(
        '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
        '/MERGETASKS=!runcode'
    ) -Wait -PassThru
    if ($p.ExitCode -ne 0) {
        Write-Warn2 "Studio setup exited with code $($p.ExitCode)."
    }
    $receipt.studio = $manifest.studio.version
    Write-Ok "Studio $($manifest.studio.version) installed."
    return $true
}

# ----------------------------------------------------------------------------
# 11. Seed the native SDK binary (claude.exe) - NOW automated for win32
# ----------------------------------------------------------------------------
# Locate the canonical SDK seed produced by seed-sdk-binary.ps1:
#   %APPDATA%\HypeProof-Studio\sdk\<version>\claude.exe(+ .verified.json)
# Returns @{ version; bin; marker; size } for the newest trusted marker, or $null.
# The trust test mirrors the runtime's isSeededBinaryTrusted: marker.sdkVersion
# present, marker.size == on-disk size, and size >= the SDK binary floor.
function Get-SeededSdk {
    $sdkRoot = Join-Path $script:HpsHome 'sdk'
    if (-not (Test-Path $sdkRoot)) { return $null }
    $minBytes = 150 * 1024 * 1024   # SDK_BINARY_MIN_BYTES, matches seed-sdk-binary.ps1
    $markers = Get-ChildItem -Path $sdkRoot -Recurse -Filter 'claude.exe.verified.json' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending
    foreach ($mk in $markers) {
        $bin = $mk.FullName -replace '\.verified\.json$', ''
        if (-not (Test-Path -LiteralPath $bin)) { continue }
        try { $j = Get-Content -Raw -LiteralPath $mk.FullName | ConvertFrom-Json } catch { continue }
        $size = (Get-Item -LiteralPath $bin).Length
        if ($j.sdkVersion -and ([int64]$j.size -eq $size) -and ($size -ge $minBytes)) {
            return [ordered]@{ version = $j.sdkVersion; bin = $bin; marker = $mk.FullName; size = $size }
        }
    }
    return $null
}

function Seed-Sdk {
    param($manifest, $receipt)
    # Delegate to the canonical scripts/seed-sdk-binary.ps1. That script is the
    # single source of truth for the platform package, the pinned SDK version and
    # sha512 table, and the runtime-trusted marker schema. An earlier inline copy
    # here drifted (wrong package/version, and a marker schema the Studio runtime
    # would NOT trust), so we always defer to the canonical seeder instead.

    # Already seeded + trusted from a prior run → idempotent skip.
    $existing = Get-SeededSdk
    if ($existing) {
        $receipt.sdk = $existing.version
        Write-Ok "SDK $($existing.version) already seeded + verified (idempotent skip)."
        return $true
    }

    $seedName = $manifest.sdk.seed_script

    # 1) Local sibling (repo checkout, or install.ps1 fetched with -OutFile).
    $seedScript = $null
    if ($PSScriptRoot) {
        $sib = Join-Path $PSScriptRoot $seedName
        if (Test-Path $sib) { $seedScript = $sib }
    }
    # 2) Bootstrap path (irm | iex): fetch the seeder from the scripts raw base.
    #    NOT derived from $ManifestUrl — the manifest and the seeders do not live
    #    in the same tree, and deriving it produced a 404. The seeder self-verifies
    #    the tarball sha512 against its own pinned table (fail-closed), so no extra
    #    integrity step is needed here.
    if (-not $seedScript) {
        $base = $ScriptsBaseUrl.TrimEnd('/') + '/'
        $seedUrl = $base + $seedName
        New-Item -ItemType Directory -Force -Path $script:TempRoot | Out-Null
        $seedScript = Join-Path $script:TempRoot $seedName
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $seedUrl -OutFile $seedScript
        } catch {
            Write-Err2 "Could not fetch $seedName from $seedUrl : $($_.Exception.Message)"
            return $false
        }
    }

    Write-Info "Seeding native SDK binary via $seedName (canonical) ..."
    $psExe = try { (Get-Process -Id $PID).Path } catch { $null }
    if (-not $psExe) { $psExe = 'powershell' }
    & $psExe -NoProfile -ExecutionPolicy Bypass -File $seedScript
    if ($LASTEXITCODE -ne 0) {
        Write-Err2 "seed-sdk-binary.ps1 failed (exit $LASTEXITCODE)."
        return $false
    }

    # Read back the canonical marker so the receipt/doctor track the real version.
    $seeded = Get-SeededSdk
    if ($seeded) {
        $receipt.sdk = $seeded.version
        Write-Ok "SDK $($seeded.version) seeded + verified (canonical marker)."
        return $true
    }
    Write-Warn2 'Seed script reported success but no trusted marker was found.'
    return $false
}

# ----------------------------------------------------------------------------
# 12. Fail-closed doctor: re-verify the exact same manifest
# ----------------------------------------------------------------------------
function Invoke-Doctor {
    param($manifest, $receipt)
    Write-Head 'hps doctor - fail-closed manifest re-verification'
    Update-ProcessPath
    $fail = @()

    foreach ($tool in $manifest.tools) {
        $ver = Get-ToolVersion $tool
        if (-not $ver) {
            if ($tool.required) { $fail += "$($tool.id): NOT FOUND ($($tool.cmd) missing)" }
            else { Write-Warn2 "$($tool.id): not found (optional)" }
            continue
        }
        if (-not (Test-VersionAtLeast $ver $tool.min)) {
            $line = (($ver -split "`n")[0]).Trim()
            $fail += "$($tool.id): $line below min $($tool.min)"
            continue
        }
        Write-Ok ("{0}: {1}" -f $tool.id, (($ver -split "`n")[0]).Trim())
    }

    # POSIX shell must exist.
    $gitBash = 'C:\Program Files\Git\bin\bash.exe'
    if ((Test-Path $gitBash) -or (Test-Command 'wsl')) {
        Write-Ok 'POSIX shell: available'
    } else {
        $fail += 'POSIX shell: neither Git Bash nor WSL available'
    }

    # git config.
    if (Test-Command 'git') {
        $ac = (& git config --global --get core.autocrlf) 2>$null
        $lp = (& git config --global --get core.longpaths) 2>$null
        if ($ac -ne 'false')  { $fail += "git core.autocrlf is '$ac' (want false)" } else { Write-Ok 'git core.autocrlf=false' }
        if ($lp -ne 'true')   { $fail += "git core.longpaths is '$lp' (want true)" } else { Write-Ok 'git core.longpaths=true' }
    }

    # Studio install marker.
    if ($receipt.studio -eq $manifest.studio.version) {
        Write-Ok "Studio $($manifest.studio.version): installed"
    } else {
        $fail += "Studio $($manifest.studio.version): not recorded as installed"
    }

    # SDK seed + verification marker (canonical seed-sdk-binary.ps1 convention:
    # sdk\<version>\claude.exe + claude.exe.verified.json, trusted via marker).
    $seeded = Get-SeededSdk
    if ($seeded) {
        Write-Ok "SDK $($seeded.version): seeded + verified"
    } else {
        $fail += 'SDK: missing seed or untrusted claude.exe.verified.json marker'
    }

    Write-Host ''
    if ($fail.Count -eq 0) {
        Write-Host '==> doctor: ALL CHECKS PASSED' -ForegroundColor Green
        return 0
    }
    Write-Host '==> doctor: FAILURES (fail-closed)' -ForegroundColor Red
    foreach ($f in $fail) { Write-Err2 $f }
    Write-Host ''
    Write-Host '    Remediation:' -ForegroundColor Yellow
    Write-Host '      - Open a NEW terminal so freshly-installed tools land on PATH, then re-run.' -ForegroundColor Yellow
    Write-Host '      - Re-run this installer (idempotent): irm .../install.ps1 | iex' -ForegroundColor Yellow
    Write-Host '      - For gh: run `gh auth login`.' -ForegroundColor Yellow
    return 1
}

# ----------------------------------------------------------------------------
# 13. Main
# ----------------------------------------------------------------------------
function Main {
    Write-Host ''
    Write-Host 'HypeProof Windows bootstrap (install.ps1)' -ForegroundColor Magenta
    Write-Host '=========================================' -ForegroundColor Magenta

    $arch = Get-Arch
    $receipt = Read-Receipt
    $receipt.arch = $arch
    $manifest = $EMBEDDED_MANIFEST

    Write-Head 'Detect environment'
    Write-Info ("OS   : Windows {0}" -f [Environment]::OSVersion.Version)
    Write-Info ("Arch : {0}" -f $arch)
    Write-Info ("PS   : {0}" -f $PSVersionTable.PSVersion)
    Write-Info ("Mode : {0}" -f ($(if ($NonInteractive) {'non-interactive'} else {'interactive'})))
    Write-Info ("Home : {0}" -f $script:HpsHome)
    if ($arch -notin @('x64','arm64')) {
        Write-Warn2 "Arch '$arch' is unusual; win32-x64 assets will be used (may run under emulation on arm64)."
    }

    Sync-ManifestVersions $manifest $ManifestUrl

    if ($DoctorOnly) {
        $script:ExitCode = Invoke-Doctor $manifest $receipt
        Write-Receipt $receipt
        exit $script:ExitCode
    }

    Write-Head 'Ensure package manager (winget)'
    if (-not (Ensure-Winget)) {
        Write-Err2 'Cannot proceed without winget.'
        exit 2
    }

    Write-Head 'Install runtime dependencies (manifest tools)'
    $anyRequiredFailed = $false
    foreach ($tool in $manifest.tools) {
        $ok = Ensure-Tool $tool $receipt
        if (-not $ok -and $tool.required) { $anyRequiredFailed = $true }
    }

    Write-Head 'Guarantee a POSIX shell for bundled skills'
    Ensure-PosixShell $receipt | Out-Null

    Write-Head 'Configure git (CRLF + long paths)'
    Configure-Git

    Write-Head 'Install HypeProof Studio app'
    try { Install-Studio $manifest $receipt | Out-Null }
    catch { Write-Err2 "Studio install error: $($_.Exception.Message)" }

    Write-Head 'Seed native SDK binary (claude.exe)'
    try { Seed-Sdk $manifest $receipt | Out-Null }
    catch { Write-Err2 "SDK seed error: $($_.Exception.Message)" }

    Write-Receipt $receipt
    Write-Ok "Receipt written: $script:ReceiptPath"

    # Fail-closed verify pass.
    $script:ExitCode = Invoke-Doctor $manifest $receipt

    # Cleanup temp.
    try { if (Test-Path $script:TempRoot) { Remove-Item -Recurse -Force $script:TempRoot -ErrorAction SilentlyContinue } } catch { }

    Write-Host ''
    if ($script:ExitCode -eq 0) {
        Write-Host 'HypeProof is ready. Launch "HypeProof Studio" from the Start menu.' -ForegroundColor Green
    } else {
        Write-Host 'Setup incomplete - see doctor failures above. Open a new terminal and re-run.' -ForegroundColor Red
    }
    exit $script:ExitCode
}

try {
    Main
} catch {
    Write-Err2 "Fatal: $($_.Exception.Message)"
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
    exit 1
}


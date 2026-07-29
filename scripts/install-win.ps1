# One-line installer for HypeProof Studio on Windows.
#
# Usage (family members run in PowerShell):
#   irm https://hypeproof.ai/install.ps1 | iex
# or:
#   irm https://raw.githubusercontent.com/jayleekr/hypeproof-studio-releases/main/install-win.ps1 | iex

$ErrorActionPreference = "Stop"
$Repo = "jayleekr/hypeproof-studio-releases"
$AppName = "HypeProof Studio"
$Tag = if ($env:HPS_VERSION) { $env:HPS_VERSION } else { "latest" }
$Tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("hps-" + [Guid]::NewGuid().ToString("N"))) -Force

function Say($msg) { Write-Host "`n▶ $msg" -ForegroundColor Magenta }
function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

try {
    # 1. Resolve release
    $api = if ($Tag -eq "latest") {
        "https://api.github.com/repos/$Repo/releases/latest"
    } else {
        "https://api.github.com/repos/$Repo/releases/tags/$Tag"
    }

    Say "Looking up release ($Tag)..."
    $release = Invoke-RestMethod -Uri $api -Headers @{ "User-Agent" = "hps-install" }
    $asset = $release.assets | Where-Object { $_.name -match "UserSetup.*x64.*\.exe$" } | Select-Object -First 1
    if (-not $asset) {
        $asset = $release.assets | Where-Object { $_.name -match "Setup.*x64.*\.exe$" } | Select-Object -First 1
    }
    if (-not $asset) { Fail "No Windows x64 installer .exe found in $Tag release. Visit https://github.com/$Repo/releases" }

    # 2. Download
    $installer = Join-Path $Tmp.FullName $asset.name
    Say "Downloading $($asset.browser_download_url)"
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installer -UseBasicParsing

    # 3. SmartScreen warning notice
    Write-Host ""
    Write-Host "⚠  Windows SmartScreen may warn ('Windows protected your PC')." -ForegroundColor Yellow
    Write-Host "   This is expected - the build is currently unsigned." -ForegroundColor Yellow
    Write-Host "   Click 'More info' -> 'Run anyway' to proceed." -ForegroundColor Yellow
    Write-Host ""

    # 4. Run installer
    Say "Launching installer..."
    Start-Process -FilePath $installer -Wait

    Say "Done."
    Write-Host "`n✅ $AppName 설치 완료." -ForegroundColor Green
    Write-Host "문제가 있으면: 운영자(Jay)에게 단톡방으로 알려주세요."
}
catch {
    Fail $_.Exception.Message
}
finally {
    if (Test-Path $Tmp) { Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue }
}

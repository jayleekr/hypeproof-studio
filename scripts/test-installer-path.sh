#!/usr/bin/env bash
# 회귀 TC — install.ps1 의 Update-ProcessPath 가 **PATH 를 잃지 않는가**.
#
# 왜 이게 필요한가 (2026-08-21, SK바이오팜 헬프데스크 실기기 13대 중 6대):
#   Update-ProcessPath 가 $env:Path 를 레지스트리 Machine+User 로 **덮어썼다**.
#   레지스트리는 "방금 설치된 것"의 권위이지 살아있는 프로세스 PATH 의 상위집합이
#   아니다. 갓 이미징한 Windows 프로필은 User PATH 가 비어 있을 수 있고, 그때
#   프로세스가 물려받은 %LOCALAPPDATA%\Microsoft\WindowsApps 가 통째로 날아간다.
#   그 폴더에 winget 의 앱 실행 별칭 스텁이 있다 — 즉 이 한 줄이 winget 을 지웠다.
#
#   Ensure-Tool 은 도구를 설치할 때마다 이 함수를 부른다. 그래서 피해가 **첫 번째
#   도구 직후**에 떨어진다: git(매니페스트 1번)은 깔리고, 그 뒤 gh·node·python·jq
#   가 전부 "NOT FOUND". 현장 로그가 정확히 그 모양이었고, 무작위가 아니라 늘
#   같은 네 개였다.
#
#   현장은 이것을 "winget 패키지 4개가 깨졌다"로 읽었다. 실제로는 PATH 항목 하나가
#   사라진 것이고, 그게 네 번 잘못된 어휘로 보고된 것이다.
#
# 대조군을 둘 다 돌린다 (rules/verification.md §2):
#   음성 — 옛 구현이 WindowsApps 를 **잃어야** 한다. 안 잃으면 진단이 틀린 것이고
#          이 TC 는 아무것도 지키지 못한다
#   양성 — 현재 구현이 WindowsApps 를 **지켜야** 한다
#
# macOS/Linux 의 pwsh 는 'Machine'/'User' 타겟에 $null 을 돌려준다. 그게 마침
# "User PATH 가 비어 있는 신선한 프로필"과 같은 모양이라, Windows 기기 없이
# 실물 조건을 재현할 수 있다. 실제 설치는 하지 않는다(네트워크·디스크 0).

set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v pwsh >/dev/null 2>&1; then
    echo "SKIP: pwsh 없음 (brew install powershell)"
    exit 0
fi

SCRIPT=scripts/install.ps1
[ -f "$SCRIPT" ] || { echo "FAIL: $SCRIPT 없음"; exit 1; }

# 임시 파일을 리포 안에 만든다. Git Bash for Windows 에서 `mktemp -t` 는 bash 식
# 경로를 돌려주고 pwsh 는 그것을 작업 디렉토리로 오해해 경고를 뱉는다. 상대 경로로
# 두면 bash 와 pwsh 가 같은 것을 가리킨다.
TMP=.hps-pathtest.ps1
trap 'rm -f "$TMP"' EXIT

cat > "$TMP" <<'PS1'
param([string]$ScriptPath)

$WINAPPS = 'C:\Users\SKBP\AppData\Local\Microsoft\WindowsApps'
$env:LOCALAPPDATA = 'C:\Users\SKBP\AppData\Local'
$env:Path = "C:\Windows;$WINAPPS"

# 2026-07-29 ~ 2026-08-21 사이 실제로 배포됐던 구현. 음성 대조군이다.
function Update-ProcessPath-OLD {
    $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $u = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (($m, $u) -join ';')
}

# 현재 구현은 파일에서 그대로 읽어와 정의한다 — 복붙 사본이 드리프트하면
# TC 가 실물이 아니라 자기 사본을 검사하게 된다.
$src = Get-Content $ScriptPath -Raw
$match = [regex]::Match($src, '(?ms)^function Update-ProcessPath \{.*?^\}')
if (-not $match.Success) {
    Write-Host 'FAIL: install.ps1 에서 Update-ProcessPath 를 못 찾았다 (이름이 바뀌었나?)'
    exit 1
}
Invoke-Expression $match.Value

$before = $env:Path
Update-ProcessPath-OLD
$old = $env:Path
$env:Path = $before
Update-ProcessPath
$new = $env:Path

$oldHas = (($old -split ';') -contains $WINAPPS)
$newHas = (($new -split ';') -contains $WINAPPS)

Write-Host ("  OLD -> '{0}'" -f $old)
Write-Host ("        WindowsApps 보존: {0}" -f $oldHas)
Write-Host ("  NEW -> '{0}'" -f $new)
Write-Host ("        WindowsApps 보존: {0}" -f $newHas)
Write-Host ''

if ($oldHas) {
    Write-Host 'FAIL (음성 대조군): 옛 구현이 버그를 재현하지 않는다.'
    Write-Host '  진단이 틀렸거나 재현 조건이 어긋났다. 이 TC 는 지금 아무것도 못 지킨다.'
    exit 1
}
if (-not $newHas) {
    Write-Host 'FAIL (양성 대조군): 현재 구현이 WindowsApps 를 잃는다.'
    Write-Host '  winget 이 PATH 에서 사라져 첫 도구 이후 전부 NOT FOUND 가 된다 (#664 현장 결함).'
    exit 1
}

# 프로세스가 원래 갖고 있던 것도 잃지 않아야 한다.
if (($new -split ';') -notcontains 'C:\Windows') {
    Write-Host 'FAIL: 레지스트리에 없는 기존 PATH 항목(C:\Windows)이 사라졌다.'
    exit 1
}

Write-Host 'PASS: 옛 구현은 winget 을 잃고, 현재 구현은 지킨다.'
PS1

# --- winget 소스 고정 ------------------------------------------------------
# 기업망 TLS 검사에서 msstore 소스의 인증서 검증이 깨지면, 소스를 안 고른 winget
# 은 그 소스 하나 때문에 명령 전체를 실패로 끝낸다(0x8a15005e). SK바이오팜
# 2026-08-21 현장이 이것이었다. install 경로 **둘 다**(user scope, machine scope
# 재시도) 소스가 고정돼 있어야 한다 -- 재시도에서 빠뜨리면 반만 고친 것이 된다.
installs=$(grep -c "^\s*'install', '--id'\|& winget install --id" "$SCRIPT")
pinned=$(grep -c "'--source', 'winget'\|--source winget" "$SCRIPT")
if [ "$pinned" -lt "$installs" ]; then
    echo "FAIL: winget install 경로 ${installs}개 중 ${pinned}개만 --source 가 고정됐다"
    exit 1
fi
echo "PASS: winget install 경로 ${installs}개 전부 --source winget 고정"

# --- 하드 요구 집합 --------------------------------------------------------
# required=$true 는 "제품이 이것 없이 돌지 않는가" 만 뜻한다. 여기에 과하게
# 표시하면 fail-closed doctor 가 멀쩡한 기기를 설치 실패로 만든다(같은 현장).
for t in gh node python jq; do
    if grep -qE "id='$t';.*required=\\\$true" "$SCRIPT"; then
        echo "FAIL: '$t' 가 하드 요구로 표시됐다."
        echo "  아동 트랙은 코치에게 셸을 주지 않아(execute_shell:false) 이 도구가 호출될 경로가 없다."
        echo "  정말 필요해졌다면 프로필 쪽 근거를 먼저 확인하고 이 TC 를 같이 고쳐라."
        exit 1
    fi
done
for t in git curl; do
    if ! grep -qE "id='$t';.*required=\\\$true" "$SCRIPT"; then
        echo "FAIL: '$t' 는 하드 요구여야 한다 (git 은 Git Bash = POSIX shell 을 같이 깐다)."
        exit 1
    fi
done
echo "PASS: 하드 요구 = git·curl, 나머지는 optional"
echo ''

echo "test-installer-path: Update-ProcessPath 대조군"
pwsh -NoProfile -File "$TMP" -ScriptPath "$SCRIPT"

# 문법 게이트 — 이 파일은 전 참가자가 실행한다. 파싱이 깨지면 설치가 전멸한다.
#
# 경로는 **pwsh 가 직접 해석하게** 한다. bash 쪽에서 "$PWD/$SCRIPT" 로 조립하면
# Git Bash for Windows 의 $PWD 가 `/d/a/...` 라 `D:\d\a\...` 가 되어 파일을 못 찾는다
# (2026-08-21 CI 에서 실제로 이렇게 죽었다 — 계측기 결함이지 제품 결함이 아니었다).
cat > "$TMP" <<'PS1'
param([string]$ScriptPath)
$full = (Resolve-Path -LiteralPath $ScriptPath).Path
$errs = $null
[System.Management.Automation.Language.Parser]::ParseFile($full, [ref]$null, [ref]$errs) | Out-Null
if ($errs -and $errs.Count) {
    Write-Host "FAIL: 파싱 오류 $($errs.Count) 건 ($full)"
    $errs | Select-Object -First 5 | ForEach-Object {
        Write-Host ('  line {0}: {1}' -f $_.Extent.StartLineNumber, $_.Message)
    }
    exit 1
}
Write-Host 'PASS: install.ps1 파싱 0 오류'
PS1
pwsh -NoProfile -File "$TMP" -ScriptPath "$SCRIPT"

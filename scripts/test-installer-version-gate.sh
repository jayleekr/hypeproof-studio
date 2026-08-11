#!/bin/sh
# 설치기의 manifest 버전 게이트 회귀 TC.
#
# 왜 이게 필요한가 (2026-08-10, 순정 macOS VM 에서 재현):
#   install.sh 의 의존성 검사와 doctor 가 **존재만** 보고 버전을 보지 않았다.
#   stock macOS 의 /usr/bin/python3 (3.9.6) 이 manifest 의 min_version 3.11 을
#   만족하는 것으로 취급되어
#     ① python@3.11 이 아예 설치되지 않고
#     ② 그럼에도 "doctor: all manifest checks passed" 가 찍혔다.
#   개발기·CI 러너에는 이미 3.11+ 가 있어 늘 통과했고, 순정 기기에서만 터진다.
#   #544 와 같은 계열의 함정이다 — 그래서 같은 방식으로 기기 없이 고정한다.
#
#   ※ 참고: repo 의 scripts/hps-doctor.sh 는 처음부터 min_version 을 강제했다.
#     doctor 가 둘이었고 설치기 쪽만 비어 있었다. 이 TC 는 그 비대칭을 막는다.
#
# 실제 설치를 하지 않으므로 네트워크·디스크를 쓰지 않고 1초에 끝난다.
#
# 대조군을 둘 다 넣는다 (.claude/rules/verification.md §2):
#   음성 — 최소 미만은 반드시 걸려야 한다. 통과하면 게이트가 고장난 것
#   양성 — 충족 버전은 통과해야 한다. 너무 엄격하지 않은지
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
FAILED=0
ok()   { printf '  ok   %s\n' "$1"; }
bad()  { printf '  FAIL %s\n' "$1"; FAILED=$((FAILED + 1)); }

# 정의만 로드 (아무것도 설치하지 않는다)
HPS_LIB_ONLY=1 . "$HERE/install.sh"

echo "=== 1. 하네스 검증 (게이트가 진짜로 잡는가) ==="

# --- ver_ge 대조군 ---
if ver_ge "3.9.6" "3.11"; then bad "음성: 3.9.6 >= 3.11 로 판정됐다 — 비교기 고장"
else ok "음성 대조군: 3.9.6 < 3.11 를 걸러낸다 (stock macOS 의 그 버전)"; fi

if ver_ge "3.11.5" "3.11"; then ok "양성 대조군: 3.11.5 >= 3.11 는 통과한다"
else bad "양성: 3.11.5 가 3.11 미만으로 판정됐다 — 과도하게 엄격"; fi

if ver_ge "3.11" "3.11"; then ok "경계: 정확히 같은 버전은 통과한다"
else bad "경계: 동일 버전이 거부됐다"; fi

if ver_ge "22.23.2" "18.0"; then ok "자릿수: 22.23.2 >= 18.0 (문자열 비교였다면 실패했을 케이스)"
else bad "자릿수: 22.23.2 가 18.0 미만으로 판정됐다"; fi

# --- 버전 추출기 대조군 (실제 출력 형태) ---
check_extract() {  # check_extract <설명> <출력> <기대>
  got="$(printf '%s\n' "$2" | sed -n 's/[^0-9]*\([0-9][0-9]*\(\.[0-9][0-9]*\)*\).*/\1/p')"
  if [ "$got" = "$3" ]; then ok "추출: $1 → $got"
  else bad "추출: $1 → '$got' (기대 '$3')"; fi
}
check_extract "git version 2.39.5" "git version 2.39.5" "2.39.5"
check_extract "Python 3.9.6"       "Python 3.9.6"       "3.9.6"
check_extract "jq-1.7.1-apple"     "jq-1.7.1-apple"     "1.7.1"
check_extract "v22.23.2 (node)"    "v22.23.2"           "22.23.2"
check_extract "gh version 2.97.0"  "gh version 2.97.0 (2026-07-31)" "2.97.0"

echo ""
echo "=== 2. manifest 와 임베드 값이 일치하는가 ==="
# dependencies.yaml 이 single source of truth 다. 임베드 표가 뒤처지면 잡는다.
MANIFEST="$HERE/../dependencies.yaml"
for id in git gh python jq node; do
  embedded="$(dep_min_version "$id")"
  yaml="$(awk -v want="$id" '
    $1=="-" && $2=="id:" { cur=$3 }
    cur==want && $1=="min_version:" { gsub(/"/,"",$2); print $2; exit }
  ' "$MANIFEST")"
  if [ "$embedded" = "$yaml" ]; then ok "$id: min $embedded (manifest 와 일치)"
  else bad "$id: 임베드 '$embedded' ≠ manifest '$yaml' — 표가 뒤처졌다"; fi
done

echo ""
echo "=== 3. tier 정책 — 강제하지 않아야 할 것 ==="
# bash 는 maintainer 티어(min 5.0)다. 강제하면 /bin/bash 3.2 인 macOS 설치가
# 전부 깨진다. hps-doctor.sh 도 warn 으로만 다룬다.
if [ -z "$(dep_min_version bash)" ]; then ok "bash: 강제 대상 아님 (maintainer 티어 — macOS 3.2 를 깨지 않는다)"
else bad "bash 에 최소 버전이 걸렸다 — macOS 설치가 전부 실패한다"; fi
if [ -z "$(dep_min_version curl)" ]; then ok "curl: 강제 대상 아님"
else bad "curl 에 최소 버전이 걸렸다"; fi

echo ""
echo "=== 4. 두 호출 지점에 게이트가 실제로 배선됐는가 ==="
# 존재만 보던 곳이 두 군데였다 — 하나만 고치면 반쪽이다.
for site in install_one_dep doctor; do
  body="$(awk -v fn="$site" '$0 ~ "^"fn"\\(\\)" {p=1} p {print} p && /^}$/ {exit}' "$HERE/install.sh")"
  if printf '%s' "$body" | grep -q "dep_satisfies_min"; then ok "$site(): 버전 게이트 배선됨"
  else bad "$site(): 버전 게이트가 없다 — 존재만 보고 통과시킨다"; fi
done

echo ""
if [ "$FAILED" -gt 0 ]; then
  echo "FAIL — ${FAILED}건"
  exit 1
fi
echo "PASS — manifest 버전 게이트 정상"

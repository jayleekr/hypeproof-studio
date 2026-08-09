#!/usr/bin/env bash
# 회귀 TC — install.sh 를 `curl | bash` 형태로 돌렸을 때 **끝까지 도달하는가**.
#
# 왜 이게 필요한가 (2026-08-09, 공기계 macOS VM 에서 재현):
#   파이프로 실행하면 bash 는 스크립트를 stdin 에서 조금씩 읽어가며 실행한다.
#   그런데 install.sh 가 부르는 Homebrew 설치기와 그것이 부르는 CLT 설치
#   (softwareupdate)가 **같은 stdin 을 소비**한다. 아직 안 읽은 뒷부분
#   ([4] Studio 설치 · [5] SDK 시드 · [6] doctor)이 통째로 사라지고, bash 는
#   EOF 를 만나 그대로 **exit 0** 으로 끝난다. 참가자 화면에는 "설치 완료" 가
#   뜨고 앱은 없다.
#
#   brew·CLT 가 이미 있는 기기에서는 stdin 을 먹는 놈이 없어 재현되지 않는다.
#   그래서 개발기·CI 에서는 늘 통과했고 공기계에서만 터졌다. #544 에서
#   "파이프로 들어오면 자기 자신을 파일로 받아 exec" 로 고쳤다.
#
# 이 TC 는 그 조건을 **공기계 없이** 재현한다: stdin 을 통째로 삼키는 가짜
# 명령을 심고, 스크립트가 그 뒤 지점까지 도달하는지만 본다. 실제 설치는
# 하지 않는다(네트워크·디스크 0).
#
# 대조군을 둘 다 돌린다 (rules/verification.md §2):
#   음성 대조군 — 가드가 없는 사본은 **반드시 실패**해야 한다 → 계측기가
#                 진짜로 잡는지 증명. 이게 통과해버리면 TC 가 무의미하다.
#   양성 대조군 — 파이프가 아닌 정상 실행은 **통과**해야 한다 → 너무 엄격하지
#                 않은지 증명.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="${REPO_ROOT}/scripts/install.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail=0
pass() { printf '  ok   %s\n' "$1"; }
bad()  { printf '  FAIL %s\n' "$1"; fail=1; }

[ -f "$INSTALLER" ] || { echo "FAIL installer not found: $INSTALLER"; exit 1; }

# ---------------------------------------------------------------------------- #
# 하네스: stdin 을 삼키는 가짜 환경
#
# install.sh 의 실제 부수효과(brew 설치, 162MB 다운로드, /Applications 쓰기)를
# 일으키지 않으려고, 스크립트를 그대로 쓰지 않고 **같은 구조의 재현본**을 만든다.
# 재현하는 것은 딱 하나 — "중간 자식이 stdin 을 다 먹으면 뒷부분이 사라지는가".
# ---------------------------------------------------------------------------- #

# stdin 을 끝까지 빨아들이는 자식. 실제로는 Homebrew 설치기 / softwareupdate.
cat > "${WORK}/stdin-eater.sh" <<'EOF'
#!/usr/bin/env bash
cat > /dev/null    # stdin 을 통째로 소비한다
EOF
chmod +x "${WORK}/stdin-eater.sh"

# (A) 음성 대조군 — 가드가 없는 스크립트. 파이프로 주면 뒷부분이 날아가야 한다.
cat > "${WORK}/unguarded.sh" <<EOF
#!/usr/bin/env bash
set -eu
echo "STEP_EARLY"
"${WORK}/stdin-eater.sh"
echo "STEP_LATE"
EOF

# (B) 가드가 있는 스크립트 — install.sh 와 같은 방식으로 자기를 파일로 re-exec.
cat > "${WORK}/guarded.sh" <<EOF
#!/usr/bin/env bash
set -eu
_is_piped() {
  case "\${0##*/}" in bash|sh|dash|zsh|-bash|-sh) return 0 ;; esac
  [ -r "\$0" ] || return 0
  return 1
}
if [ -z "\${GUARD_REEXEC:-}" ] && _is_piped; then
  GUARD_REEXEC=1 exec bash "${WORK}/guarded.sh" "\$@"
fi
echo "STEP_EARLY"
"${WORK}/stdin-eater.sh"
echo "STEP_LATE"
EOF

echo "=== 1. 하네스 검증 (계측기가 진짜로 잡는가) ==="

# 음성 대조군: 파이프 + 가드 없음 → STEP_LATE 가 사라져야 정상
out="$(cat "${WORK}/unguarded.sh" | bash 2>&1)"
if printf '%s' "$out" | grep -q STEP_LATE; then
  bad "음성 대조군이 통과해버렸다 — 이 하네스는 stdin 소비를 재현하지 못한다"
else
  pass "음성 대조군: 가드 없는 스크립트는 파이프에서 뒷부분을 잃는다 (기대대로)"
fi

# 양성 대조군: 파이프 + 가드 있음 → 끝까지 가야 한다
out="$(cat "${WORK}/guarded.sh" | bash 2>&1)"
if printf '%s' "$out" | grep -q STEP_LATE; then
  pass "양성 대조군: 가드가 있으면 파이프에서도 끝까지 간다"
else
  bad "양성 대조군이 실패했다 — 가드 방식 자체가 동작하지 않는다"
fi

echo
echo "=== 2. 실제 install.sh 가 그 가드를 갖고 있는가 ==="

# 가드의 세 조각이 모두 있어야 한다. 하나라도 빠지면 파이프에서 다시 조용히 끊긴다.
for probe in '_hps_is_piped' 'HPS_REEXEC' 'exec bash'; do
  if grep -q -- "$probe" "$INSTALLER"; then
    pass "install.sh 에 '${probe}' 존재"
  else
    bad "install.sh 에 '${probe}' 가 없다 — curl|bash 가 다시 조용히 끊긴다 (#544)"
  fi
done

# 이중 안전장치: brew 설치기 호출이 stdin 을 못 먹게 막혀 있는가.
if grep -A4 'Homebrew/install/HEAD/install.sh' "$INSTALLER" | grep -q '/dev/null'; then
  pass "brew 설치기 호출에 stdin 차단(</dev/null)이 남아 있다"
else
  bad "brew 설치기 호출의 stdin 차단이 사라졌다 — 이중 안전장치 상실 (#544)"
fi

echo
echo "=== 3. 가드가 정상 실행을 방해하지 않는가 ==="

# 파일로 직접 실행할 때는 re-exec 가 일어나면 안 된다(무한 재실행·불필요한 재다운로드).
# --help 는 부수효과 없이 즉시 종료하는 유일한 경로라 이걸로 확인한다.
if out="$(bash "$INSTALLER" --help 2>&1)"; then
  if printf '%s' "$out" | grep -q 'Usage: install.sh'; then
    pass "파일 실행 경로는 그대로 동작한다 (--help 정상)"
  else
    bad "--help 출력이 예상과 다르다"
  fi
else
  bad "파일로 실행했더니 --help 가 실패했다 — 가드가 정상 경로를 깼다"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "PASS — curl|bash 회귀 가드 정상"
else
  echo "FAIL — #544 의 회귀. 공기계에서 설치가 조용히 중단된다."
fi
exit "$fail"

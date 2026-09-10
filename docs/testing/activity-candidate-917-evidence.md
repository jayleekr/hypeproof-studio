# 활동 연결 후보·확정 검사 — #917 첫 단계

2026-09-10. US-07의 전환 준비/취소/저장 실패 경계를 구현했다.

기존에는 코드 확인 즉시 활성 credential을 바꿨다. 이제 host 메모리에 후보를 두며
선택 취소는 기존 연결을 유지한다. 시작 시 후보를 다시 인증하고 폴더 준비 이후
credential을 저장한다. 준비 실패는 기존 폴더에서 새 활동을 실행하지 않는다.
저장 후 재인증 또는 채팅 열기 실패 시 이전 credential로 복귀한다.

## 실행 범위

- Extension typecheck, webview/extension build, 전체 smoke: PASS.
- Host 대조: 잘못된 서명/403/network/잘못된 profile, 진행 중 스트림,
  후보 취소, 폴더 준비 실패, SecretStorage 저장 실패, 저장 후 인증 실패,
  확인 이후 만료, 정상 확정, 중복 확인 경쟁, 서버 origin 변경 시 전송 차단, 시작 화면 종료 후 확정 차단: PASS.
- 기존 시작 화면 브라우저 검사와 UI 회귀: PASS. 후보 상태와 선택 취소 메시지도 검사했다.
- 실제 Mac 앱 사본에서 native grant와 일반 수업 credential을 각각 확인하고,
  후보 취소 → 코드 재입력 → 시작 → 실제 채팅 진입을 수행한다.
  아래 실제 런의 `unified-entry.json` 및 화면이 결과의 원본이다.

Local injected extension/Service 합성 fixture 검사다. API 모델 요청은 없고 과금 검증이 아니다.
Mac fixture는 자기 workspace를 고정하므로 실제 OS의 폴더 이동·권한 실패를 검증한 것으로
간주하지 않는다. 해당 실패는 host 대조로만 검사했다. 사용자 설치본을 교체하지 않았다.

## 미완료

#917 전체는 열어 둔다. 여러 활동의 저장 목록, 창별 credential 바인딩, 일반 수업의
참가자/버전별 history 분리, 동일 폴더 충돌, late event/SDK payload, 재시작·crash 복귀는
아직 NOT RUN이다. US-07 전체와 US-08~12/18을 PASS로 올리지 않는다. 공용 SecretStorage
문제를 이 첫 단계로 해결했다고 주장하지 않는다. 공개 승격은 #918/#919 인수 이후다.

## 실제 Mac 런

- `e2e/test-results/native-trial/20260910T164241Z`: trial PASS.
- `e2e/test-results/native-trial/20260910T164247Z`: classroom PASS.

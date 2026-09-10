# 공통 시작 화면 P0 실행 기록 — #916

2026-09-10. 합성 사용자 검사이며 사람의 학습 효과나 전체 통합 릴리스 인수가 아니다.

## 구현과 범위

하나의 시작 화면에서 `AI 체험하기`와 `수업에 참여하기`를 선택한다. 기존 참여 코드를
검증한 뒤 연결된 활동을 확인하고 채팅으로 진입한다. 선택은 입력 안내만 바꾸며 인증,
권한, 도구, 예산을 변경하지 않는다. `activity_kind`는 인증된 Service payload에서 파생한다.
구 Service가 필드를 보내지 않으면 App은 추측하지 않고 `활동`으로 표시한다.
개인 account는 `개인 작업`, native grant는 `AI 체험`, 기존 수업 credential은 `수업`이다.
체험 프로필을 쓰는 일반 수업 코드가 자동으로 개인 체험 권한이 되지 않는다.

별도 로그인/발급/사용량 저장소는 추가하지 않았다. 공개 코드 없는 가입은 미지원으로
안내한다. 활동 목록과 안전한 다중 활동 전환(#917), 공개 이행(#918), 자동 공개 게이트(#919)는
이 변경으로 완료하지 않는다. US-03/04/05/12/17의 진입 부분만 구현한다.

## 실행

- Extension 전체 smoke + typecheck, webview production build: PASS.
- Worker 전체 `npm test` + typecheck: PASS. native grant 검사는 실제 SQLite를 사용한다.
- `node e2e/start-page/run.mjs`: PASS. 실제 빌드 React, 통제된 host 메시지, 390/768/1280px.
- `node e2e/trial-ux/run.mjs`: PASS (47건). 통제된 host 메시지 기반 UI 회귀다.
- `HPS_UNIFIED_ENTRY=1`을 기존 `scripts/test-native-trial-laptop.sh`에 연결했다.
  동일한 macOS arm64 v0.1.56 앱 사본에 이번 extension/webview 번들을 주입했다.
  `HPS_NATIVE_MANAGED=1`로 개인 grant, 변수 없이 일반 수업 credential을 각각 실행한다.
  두 경우 실제 profile API의 인증 → 앱 코드 확인 → 채팅 진입을 검사한다.
  잘못된 코드는 거부됐고, UI에서 수업을 선택해도 native grant는 AI 체험으로 표시됐다.
  원본 파일은 보존됐으며 `index.html` 생성과 모델 요청은 없었다.

API fixture는 로컬 Service 코드와 합성 KV/SQLite만 사용한다. 실제 운영 자격이나 모델 키는
사용하지 않았다. 모델 요청이 없는 검사이므로 실제 LLM 수행/사용량 정산의 증거가 아니다.
기존 SDK 모델 실행 시나리오의 진입 locator는 구/신 App을 모두 찾도록 갱신했지만
이번 진입 변경에서 모든 모델 시나리오를 다시 실행한 것은 아니다.

로컬 증거는 `e2e/test-results/native-trial/<run>/environment.json`, `unified-entry.json`,
`unified-connected.png`, `unified-chat.png`에 남는다. environment에는 기반 App commit,
현재 checkout 및 dirty 상태, 주입 bundle hash, Service source hash가 있다.
통합 US-T03/04/05/13/15의 일부만 검증했으며 해당 행 전체 PASS로 올리지 않는다.
공개 App 빌드·배포·설치·재시작, Windows 인수, US-T01/02/06~12/14/16~21은 NOT RUN.

## 최종 로컬 런

- `e2e/test-results/native-trial/20260910T162836Z`: trial PASS.
- `e2e/test-results/native-trial/20260910T162843Z`: classroom PASS.
- `e2e/test-results/trial-ux/2026-09-10T16-29-32-359Z`: UI 회귀 PASS.

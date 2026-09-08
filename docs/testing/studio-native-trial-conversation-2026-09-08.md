# 개인 체험 대화 화면 검증 — 2026-09-08

사용자 피드백은 세 가지였다. 위임 범위를 고민한다고 말했는데 PPT 제작 질문으로만
넘어갔고, 대화를 시작해도 연결 화면이 오른쪽을 차지했다. 실제 수정이 없어도
‘고쳤어요’가 표시됐으며 굵은 글씨의 `**`가 그대로 보였다.

## 변경과 추적

| 의도 | 요구사항 | 구현 | 확인 |
|---|---|---|---|
| 사용자가 밝힌 고민을 유지하고 실제 과제로 시험 | NAT-03 | Service의 `studio-native-trial.md`; 표시 이름 ‘내 삶에 AI 더하기’ | 실제 모델의 3턴 대화와 별도 의미 검토 |
| 대화와 결과를 함께 보고 판단 | TUX-SP-03 | 기존 StartPage 패널을 ChatPanelProvider에 넘겨 중앙 대화로 사용; 미리보기는 옆 열 | 실제 Mac 전환·포커스·URL·초안 보존 |
| 읽을 수 있는 응답 | TUX-CHAT-15 | React Markdown + GFM, 기존 코드 블록 유지 | 일반 텍스트 음성 대조·완성/미완성 구문·HTML/외부 이미지 차단 |
| 실제 실행과 대기를 구분 | TUX-CHAT-16 / REQ-M27 | 완료된 합성 대기 줄 숨김; 처리 원문 접기; 실제 Write/실패 유지 | 브라우저 대조와 실제 텍스트 전용 응답·파일 생성 |

App은 기존 인증·대화·파일 도구·관찰 경로를 재사용한다. Service의 강의 내용이 도구
권한을 바꾸지 않는다. 사용자가 이미 완성본을 명확히 요청하면 강제 설문 없이 진행한다.

## 실행 기록

- Worker 전체 `npm test`, `typecheck`: PASS. `/tmp/hps-758-conversation-worker.log`.
- 확장 전체 `npm test`, `typecheck`: PASS. `/tmp/hps-758-conversation-extension.log`.
- 브라우저 `test:trial-ux`: 47 PASS / 0 FAIL.
  `e2e/test-results/trial-ux/2026-09-08T17-30-00-362Z/report.json`.
- Mac 초기 회귀 `20260908T172438Z`: 실제 API·파일 생성/수정·관찰·재시작 1 PASS.
  최신 main 재통합 전 검사이므로 최종 증거와 구분한다.
- `20260908T172742Z`: 화면 테스트는 처음 green이었으나 예상하지 않은 클립보드 첨부가
  발견돼 무효화했다. 첨부는 테스트 모델 요청에도 함께 전송됐다. 후속 대화 테스트는
  직접 중단했고 해당 실행의 로컬 화면·대화 파일도 제거했다. 실패 메타데이터만 남긴다.
  화면 밖 위치만으로 OS 포커스가 격리되지 않았다. 테스트 창을 `setFocusable(false)`로
  설정하고 실제 `isFocusable()` 및 첨부 부재를 검사한다. 사용자 클립보드는 수정하지 않았다.
- `20260908T173009Z`: 포커스 격리 후 실제 Markdown·텍스트 전용 파일 보존·Write·
  loopback URL 200·연결 화면 왕복 후 초안 보존 PASS. 합성 사용자 3턴도 전송 PASS. 원문 의미 검토에서 AI 초안 범위와 사람의 핵심 주장·
  수치/약속 판단을 구분하고 작은 목차를 제공한 점을 확인했다. 이 한 실행의 NAT-03은
  PASS이며 모델의 모든 대화나 사람 학습 효과로 일반화하지 않는다.

- `20260908T173156Z`: 연결 해제/재연결·파일/설정·폴더 취소/선택·Run 및 실제
  390/1280/390px 미리보기 회귀 3 PASS.
- `20260908T173255Z`: 최종 번들로 실제 API·파일 생성/수정·관찰/정정·실제 앱 재시작·
  대화 삭제 취소/확인까지 1 PASS. 원본·수정본·관찰 기록을 보존했다.
- `20260908T173522Z`: 같은 작업 폴더에서 다른 합성 사용자로 연결하면 대화/관찰이
  비어 있고 원 사용자로 돌아오면 복원되는 실제 API 검사 1 PASS.

- `20260908T173603Z`: 코드가 있는 시작과 처음 설치한 연결 화면 2 PASS.

환경: macOS arm64, Node 24.4.1, SDK 0.3.207. 공식 App 0.1.54
(`9ebed633e5b1e94a514a3b0731758faf36fc4177`)의 별도 사본에 수정한 확장을 주입했다.
검사 코드 기준 `3d721109aefb2f2ca47ff4dcaef48a70ff66f824`에 첨부 selector 보정이
있었다. 실제 번들 해시와 Service 해시는 각 실행의 `environment.json`에 있다.
이 결과를 공개 App 0.1.54에 새 기능이 포함된 증거로 해석하지 않는다.

합성 대화·화면·판정 원본은 [증거 디렉터리](../evidence/2026-09-08/trial-conversation/)에 보존했다.

## 판정의 한계

실제 Mac/Electron·API·모델·파일·브라우저를 실행한 합성 사용자 실험이다. 사람의
학습 효과, 독립 수행, 공개 호스팅 검증은 아니다. loopback URL의 서버는 검사 종료 시
정리한다. Windows 실기기, VoiceOver, 앱 내 업데이트 전체 경로와 Keychain 지속성은
기존 보고서의 NOT_RUN 상태를 유지한다. 현재 사용 중인 사용자 앱은 교체하지 않았다.

이 기록은 [앞선 전체 UX 보고서](studio-native-trial-ux-results-2026-09-08.md)의 후속이다.
배포와 공개 앱 재검증 결과는 PR/릴리스 기록과 함께 갱신한다.

## 머지와 서버 반영

[#793](https://github.com/jayleekr/hypeproof-studio/pull/793)은 최신 head
`c38d91d897d2852df61036c4f5bd5fade313f4b6`의 CI 17개 통과 후
`189bc956a01236abb82ed69542d3cdb633a0fcc3`로 머지됐다. 리뷰 요청은 팀원에게
유지했고 변경 요청 리뷰는 없었다. 보호 규칙을 우회하지 않았다.

[Service 배포](https://github.com/jayleekr/hypeproof-studio/actions/runs/34258353895)는
성공했다. `w0.0.0-dev+189bc95`, Cloudflare version
`1d32a235-1823-4a08-b63b-c7b4717cddfe`다. 정상 live-session freeze에서 0을 확인했고
SDK 요청 계약 검사가 통과했다. 공개 health와 합성 개인 체험의 profile/관찰 context는
200, 검사 코드 폐기 뒤 profile은 401이었다. 표시 이름과 1시간/40회 제한을 확인했다.
[API 결과](../evidence/2026-09-08/trial-conversation/production-api.json)는 응답 상태와
공개 설정만 포함한다. 처음 잘못 요청한 `/v1/context`의 404는 검사기 오류이며,
실제 경로 `/v1/observations/context`로 재검사했다. 두 합성 코드 모두 폐기했다.
실제 참가자 상태는 변경하지 않았고 비활성 합성 roster 식별자만 남겼다.

로컬 Service는 테스트 준비 중 `npm ci`가 실행 중인 wrangler의 의존성 경로를 교체해
한 번 중단됐다. 앱을 종료하지 않고 같은 저장소·포트·자격증명으로 Service만 복구한 뒤
health/profile 200을 확인했다. 실행 중인 Service가 사용하는 디렉터리에서는 의존성을
재설치하지 않는다. 후속 앱 검증은 준비된 의존성과 배포 파일을 그대로 재사용한다.

App v0.1.55는 위 merge SHA에서 빌드한다. 공개 파일과 실제 앱 재검증은 아래 출시
기록에서 별도로 판정한다. 복구 시 기존 App v0.1.54와 작업 폴더를 보존하며, Service는
이전 ref `fe6f7b5`의 정상 배포 절차를 사용한다.

## 공식 App v0.1.55 재검증

Mac [빌드](https://github.com/jayleekr/hypeproof-studio/actions/runs/34258354238)와
Windows [빌드·portable smoke](https://github.com/jayleekr/hypeproof-studio/actions/runs/34258354245)가
성공했다. [공개 릴리스](https://github.com/jayleekr/hypeproof-studio-releases/releases/tag/v0.1.55)의
파일 7개는 원본 릴리스와 SHA-256이 모두 일치한다. 필수 Mac zip·Windows zip·두 설치
파일의 존재도 확인했다. 검사기는 처음 파일 수를 4개로 잘못 가정해 실패했으며, 실제
필수 파일 존재와 전체 원본/공개 digest 동일성으로 수정했다. 배포 누락은 없었다.

Mac ZIP SHA-256: `73bfc4ec02ee19f39993ddc7b6685c020aeb1b1b2a007083544b0450b4fe3fc6`.
App/확장 버전 0.1.55, product commit `189bc956a01236abb82ed69542d3cdb633a0fcc3`,
`codesign --verify --deep --strict` PASS. 서명 검사는 공증·조직 관리 단말 설치를
입증하지 않는다. [공개 파일 근거](../evidence/2026-09-08/trial-conversation/public-release.json).
다음 실행은 이 원본 파일에 확장을 주입하지 않고 별도 사용자 폴더에서 진행했다.

| 실행 | 결과와 범위 |
|---|---|
| `20260908T181038Z` 화면 시나리오 | PASS: 중앙 대화, 실제 Markdown, 텍스트 응답의 파일 보존, 실제 Write, 옆 미리보기, 연결 화면 왕복 초안 |
| 같은 실행의 위임 대화 | 전송 PASS / 의미 FAIL: 역할은 구분했지만 “목차를 만들어볼게요”로 종료. 실제 초안·도구 실행 없음. #803으로 수정 |
| `20260908T181321Z` 기본 회귀 | PASS: 실제 API/파일 생성·수정/관찰·정정/앱 재시작/대화 삭제 취소·확인 |
| `20260908T181613Z` 지침 수정 후 첫 반복 | FAIL: SDK `Server error mid-response` 및 UI 오류 배너. HTTP 200 스트림 시작만으로 완료로 보지 않음. #804로 추적 |
| 같은 실행 두 번째 반복 | PASS: AI/사람 역할 구분, 실제 10장 목차, 고객 문제와 가정 확인. 파일 제작은 후속 제안이며 실행으로 집계하지 않음 |

Service 지침은 “실행 약속” 대신 같은 응답의 작은 초안 또는 실제 도구 결과를 요구하도록
보완했다. native 검사는 각 턴의 오류 배너도 확인하며, 전송과 의미 판정은 계속 분리한다.
실제 재실행 원문은 `release-first`, `release-baseline`, `release-followthrough-first`에
보존했다. 중단 원인의 업스트림 내부 사유는 미확인이다. 기존 다시 보내기 버튼의
부분 결과·중복 부작용 복구 검증은 [#804](https://github.com/jayleekr/hypeproof-studio/issues/804)에 남긴다.

로컬 `~/Library/Application Support/HypeProof/local-trial-744/releases/v0.1.55/`에
같은 공식 앱을 보관하고 데스크톱 ‘HP 개인 체험 시작.command’의 다음 실행 대상을
v0.1.55로 바꿨다. 기존 앱·대화·작업 폴더는 종료하거나 덮어쓰지 않았다. 이전 launcher와
사용안내는 `.before-v0.1.55`로 보존했다. 현재 창은 이전 버전이므로 작업 저장·종료 뒤
다음 실행부터 적용된다. 앱 갱신은 만료된 체험 코드를 갱신하거나 제한을 늘리지 않는다.

최신 main의 #795 모델 선택 변경을 검토하고 통합한 Service 코드
`e8f9d114a42cac760e4152f84fa08cd7a4e54f9e`에서 Worker 전체 test/typecheck가 다시
통과했다 (`/tmp/hps-758-followthrough-final-worker.log`). App은 계속 원본 v0.1.55다.
`20260908T182118Z`에서 같은 3턴을 별도 합성 작업 폴더로 두 번 재실행해 전송/오류
검사 2 PASS, 수동 의미 검토도 두 시료의 위임 목적·작은 초안 기준 PASS였다. 각각
7장/8장 목차를 실제 제공했다. 첫 시료는 초안 뒤 두 질문이 있어 ‘질문 최소화’ 전체
수용 조건은 이 결과로 통과시키지 않는다. 둘째 시료는 인용 부호를 포함한 비표준
강조 구문이 원문처럼 남았다. 앞서 일반 굵게/목록 검사가 통과한 것과 구분하며 모든
모델 Markdown의 완벽한 표시를 주장하지 않는다.
[최종 원문·화면·환경](../evidence/2026-09-08/trial-conversation/release-followthrough-final/).

#803의 완료 범위는 실행 약속만 남던 응답의 작은 초안 제공과 관측 강화다.
외부 모델 오류 #804, 사람 T25 및 기존 NOT_RUN은 별도로 남는다.

# 체험 대화·GitHub UX 인수 검사

상태: 계획. [요구사항](../design/trial-conversation-experience.md) · [에픽 #844](https://github.com/jayleekr/hypeproof-studio/issues/844).
작성일 2026-09-08. 아래 표는 테스트 정의이며 실행 결과가 아니다.

| ID | 조건과 확인할 결과 | 요구사항 | 상태 |
|---|---|---|---|
| CUT-01 | 새 사용자·빈 폴더/기존 폴더: 대화 중심 진입, 입력·본문 배치 및 불필요 파일 없음 | CU-01,02 | NOT RUN (전체 UI) |
| CUT-02 | 명확한 요청/막막함 지속/질문 건너뛰기: 답을 따라 탐색하거나 요청된 행동 실행 | CU-02, NAT-03 | #842·#864 실기 부분 PASS, 아래 참조 |
| CUT-03 | 전송·예약·중지·재전송·중복 클릭: 정확히 한 실행, 초안 보존 | CU-03,04,17 | NOT RUN |
| CUT-04 | 업데이트·회고·긴 답변·Markdown: 입력 안 가림, strong/list/code/link 렌더 및 포커스 | CU-01,05,16 | NOT RUN |
| CUT-05 | 무변경/Read/Write/실패/취소 대조군: 실제 실행과 문구 일치, 내역 펼침 | CU-06,07 | NOT RUN |
| CUT-06 | 문서·웹·표: 결과물별 열기, 수정 비교, 되돌림 및 사용자 변경 보존 | CU-08,09,10 | NOT RUN |
| CUT-07 | 사용 가능/수업 제한/한도 소진/공급자 잔액 부족/사용량 미확인: 다른 안내 | CU-11~15 | NOT RUN (권한 UI) |
| CUT-08 | 390·768·1280·1920px, 200% 확대, 키보드 및 스크린리더 상태·포커스 | CU-01,16 | NOT RUN |
| CUT-09 | 연결 단절·인증 만료·재시작·부분 파일: 결과와 작성 중 입력 보존 | CU-17 | NOT RUN |
| CUT-10 | 첫 유용한 결과/직접 검토/재방문 각각 관측, 학습효과 또는 독립수행으로 오인하지 않음 | CU-18 | NOT RUN |

| ID | 조건과 확인할 결과 | 요구사항 | 상태 |
|---|---|---|---|
| GHXT-01 | GitHub 없이 새 체험 수행; 필요할 때만 연결 안내 | GHX-01,02,05 | NOT RUN |
| GHXT-02 | 정상 callback/취소/만료/replay/다른 계정/위조 state: 미승인 성공 없음 | GHX-03,11 | NOT RUN |
| GHXT-03 | 선택 저장소·조직 승인 대기·SSO·private·권한 없음·목록 빈 상태 | GHX-04,09,10 | NOT RUN |
| GHXT-04 | 실제 연습 저장소 diff 확인→브랜치/PR 반영→API 커밋 readback, 시크릿 대조군 차단 | GHX-05~07 | NOT RUN |
| GHXT-05 | 원격 선행 변경/충돌/오프라인/429/재시도: 중복 업로드와 사용자 변경 손실 없음 | GHX-07,09 | NOT RUN |
| GHXT-06 | 연결 해제/외부 철회 후 원격 요청 거절, 로컬 파일 유지, 재연결 가능 | GHX-08,09 | NOT RUN |
| GHXT-07 | 강사/학생/개인 경계: 다른 좌석·수업 토큰으로 GitHub 권한 재사용 불가 | GHX-10,12 | NOT RUN |
| GHXT-08 | 실제 Mac·Windows에서 브라우저 복귀/취소/재실행, 키보드 포커스·안전한 진단 | GHX-11,12 | NOT RUN |

합성 계약 검사를 정상/오류 대조군으로 먼저 검증하고 승인된 연습 저장소로 실제 경로를 실행한다.
운영 조직을 새로 연결하거나 공개 배포를 수행해 문서 테스트를 통과시키지 않는다.
Cursor 화면 조사에서 성공한 클릭은 HP GHXT의 PASS가 아니다.

## 실제 실행한 시작 동작 (#842)

20260908T232730Z · macOS arm64 · 공개 v0.1.56 shell에 수정 extension을 넣은 별도 앱.
Service/App 소스 base 18281a9 + 이 PR 변경. 원본 공개 앱의 검증으로 보고하지 않는다.
`HPS_TRIAL_ENTRY=1 HPS_NATIVE_PORT=8789 HPS_NATIVE_REUSE_DIR=/tmp/hps-842-app bash scripts/test-native-trial-laptop.sh tests/native-trial-entry.spec.ts`

- PASS: 빈 폴더의 모호한 요청에 파일 도구 실행 없음, index.html 언급/생성 없음 (Opus).
- PASS: 기존 index.html이 있는 폴더도 불필요 파일 도구 없음, 기존 파일 내용 동일 (Opus).
- PASS: 명시적 walk.md 요청 후 실제 Markdown 작성, 다음 웹 요청에 실제 index.html 작성, 앞 문서 보존 (Haiku).
- PASS: helper 파일 시스템 대조군은 empty 시작, legacy HTML 시작 및 사용자 파일 보존 확인.
- PASS: 정상 인증·열린 세션의 /v1/profile이 empty 정책 반환; legacy 웹 프로필 회귀.

기록: `e2e/test-results/native-trial/20260908T232730Z/`의 실행 manifest, 요청·응답,
도구 내역, 파일 확인, PNG. 실행 명령과 테스트 소스는 이 PR에 포함한다.
포트 8788은 다른 프로세스가 사용 중이어서 첫 시도는 preflight BLOCKED였고 종료하지 않았다.
이후 미사용 8789로 재실행했다. 새 UI 전체·GitHub·공개 배포·학습 효과는 이 결과에 포함하지 않는다.

## 증거 형식

각 실행에 앱 버전/소스 SHA/Service SHA/프로필/합성 사용자/뷰포트/요청/실제 응답/도구/파일
해시/확인한 URL·커밋/스크린샷/PASS·FAIL·BLOCKED·NOT RUN/원인·재실행을 기록한다.
인증값·개인정보·비공개 파일 내용은 공개 커밋에 넣지 않는다. 토큰 존재는 인증·접근 성공이 아니다.

main의 #839 effort·#840 사용량 UI를 병합한 `ef9cd7096b4431f30484fbccee8786a509cf0807`에서도
20260908T233625Z에 같은 3개 실제 Mac 시나리오를 다시 실행해 3 PASS(31.2초)를 확인했다.
Worker 전체 테스트·typecheck, extension 전체 smoke·typecheck도 통과했다.
이 결과 역시 공개 shell에 해당 extension을 주입한 격리 앱이며 공개 설치본 업데이트가 아니다.

## 막막함이 이어지는 대화 (#864)

기존 NAT-03/CU-02의 다중 턴 탐색을 검증했다. [수용 조건](studio-native-trial-validation.md#t04-product-intent-분기),
실행 파일 `e2e/tests/native-trial-guidance.spec.ts`. 전체 체험 UI나 사람 학습 효과의 완료가 아니다.

### 환경과 실행

- macOS arm64, Node v24.4.1, 실제 Electron/Agent SDK/Anthropic API, Claude Opus 5.
- 변경하지 않은 공개 v0.1.56 앱: App SHA `f5939d9cf6bbf42588eacd370e2faf9cde7c53bc`.
  `/tmp/hps-828-public-v56/HypeProof Studio.app`의 별도 user-data/workspace. 앱 빌드/주입 없음.
- Service 최종 프롬프트 SHA `12d8adc` (전체 SHA는 실행 manifest).
  후속 커밋은 테스트/증거 문서이며 런타임 프롬프트는 같다.
- 정상 프로필·roster·열린 세션의 기존 로컬 fixture. 운영 사용자/저장소를 수정하지 않았다.
- `20260909T031639Z`: 중간 수정의 4개 시나리오, 사용자 입력 12개, 전송 4 PASS(1.5분).
  주제 이후의 추가 턴에서 남은 문제를 발견해 아래 최종 실행으로 대체했다.
- `20260909T031916Z`: 최종 프롬프트의 위임 고민 3턴, 전송 1 PASS(20.6초).
- `20260909T031945Z`: 같은 최종 프롬프트로 나머지 3개 시나리오 10턴, 전송 3 PASS(1.3분).
  최종 인수는 합계 4개 시나리오 13턴이며 모두 재시도 없이 실행했다.
  API 증거의 HTTP 요청 수에는 count_tokens 등 SDK 요청도 포함되므로 대화 수와 구분한다.

```bash
HPS_TRIAL_GUIDANCE=1 HPS_NATIVE_PORT=8789 \
HPS_NATIVE_RELEASE_VERIFY=1 \
HPS_NATIVE_RELEASE_SHA=f5939d9cf6bbf42588eacd370e2faf9cde7c53bc \
HPS_NATIVE_RELEASE_VERSION=0.1.56 \
HPS_NATIVE_REUSE_DIR=/tmp/hps-828-public-v56 \
bash scripts/test-native-trial-laptop.sh --grep 'still-unsure|clear-request|skip-and-change'
# 같은 환경으로 별도 실행: --grep task-name-is-not-purpose
# 13턴을 둘로 나눠 각 fixture의 HTTP 요청 상한 24회를 유지한다.
```

각 실행은 새 합성 대화로 시작한다. 정상 응답/오류 배너/기존 사용자 파일 해시를 자동 검사하고,
대화 의미는 아래 기준으로 원문을 따로 검토했다. `result.json`의 `semantic_review: PENDING`은
자동화가 대화 의미를 판정하지 않았다는 뜻이다. 이 문서와 보관 폴더의 `semantic-review.json`이
코딩 에이전트의 원문 검토를 기록한다. 사람 사용자 검증으로 표시하지 않는다.

### 수정 전과 수정 중의 실패

- `20260909T031220Z`, main `c9d32ab`: 전송/파일 보존 PASS, 의미 FAIL.
  “퇴근하고 나면 시간을 그냥 보내는 것 같아”만 듣고 19~22시 3시간을 가정해
  방향 표와 기록 틀을 먼저 제공했다. 다음 응답은 임의 기준으로 피곤함/계획 문제를 단정했다.
- `20260909T031445Z`, `cce52e2`: 전송 4 PASS, 탐색 초반 개선.
  다만 5번째 턴에 요청하지 않은 기록표와 웹 화면 제작 선택지가 나와 의미 인수 FAIL.
  이 잔여 문제를 고친 코드로 전체 4개 시나리오를 다시 실행했다.
- `20260909T031821Z`, `ab40fac`: 주제를 답해도 위임 고민이 남는 3번째 턴을 추가하자
  6장 목차가 먼저 나와 의미 FAIL. 기존 발표 예시의 주제→목차 지시를 제거하고 재실행했다.

### 최종 원문 검토

| 시나리오 | 결과 | 관측 근거 |
|---|---|---|
| 막막함 지속, 6턴 | PASS | 1~4턴은 최근 상황·저녁에 한 일을 한 번에 하나씩 물었다. 분야만 듣고 계획표를 만들지 않았다. 5턴은 활동이 바뀔 때 한 줄 남기자는 제안과 의향 확인, 6턴의 명시적 요청에는 한 관찰 활동을 채팅으로 제공했다. |
| 과제명·주제와 위임 고민, 3턴 | PASS | PPT 뒤에는 망설이는 이유를 묻고, 주제 뒤에도 본인만 아는 내용과 맡길 경계를 물었다. 목차/전체 제작으로 넘어가지 않았다. |
| 명확한 요약, 1턴 | PASS | 추가 질문 없이 금요일 오후 3시·기존 회의실·준비 자료 없음이 들어간 한 문장을 제공했다. |
| 질문 건너뛰기와 목표 변경, 3턴 | PASS | 명시한 가정 아래 활동을 추천했다. 다음 축약 요청에는 “도착하면 문자 주세요”를 제공하고 이전 탐색으로 되돌리지 않았다. |

모든 최종 턴에서 파일/검색/셸 도구 실행은 관측되지 않았고 사용자 파일 해시는 같았다.
도구 라벨의 준비 중 상태와 실제 도구 호출을 구분해 읽었다. 정상 대조는 명확한 요청의
즉시 요약과 건너뛰기의 추천이며, 음성 대조는 수정 전의 성급한 표 생성·원인 단정이다.
물음표 수나 특정 단어가 있다는 이유로 의미 PASS하지 않았다.

긴 설명·추가 대안을 덧붙이는 경향은 일부 응답에 남아 있다. 이번 PASS는 적응적 탐색과
실행 전환에 한정한다. 응답 길이·레이아웃 전반은 #845/#848 후속 검수 범위다.
다른 모델·Windows·운영 사용자 전체 흐름과 T25 사람 파일럿은 이번에 실행하지 않았다.

Worker 전체 테스트·typecheck와 docs-harness 100/100을 통과했다. 서버 배포 완료 여부는
#864와 PR의 실제 deploy 실행 링크를 따른다. 이 로컬 검사는 운영 배포 성공을 뜻하지 않는다.

증거 보관: `~/Library/Application Support/HypeProof/rehearsals/issue-864/`.
각 run의 `environment.json`, `api-evidence.json`, 시나리오별 `result.json`과 PNG를 보관한다.
인증값은 포함하지 않는다. 테스트가 띄운 앱과 gateway만 정리하며 설치 앱/기존 작업은 보존했다.

# Epic #746 기능 A 인수·인계

상태: 발견한 입력창 6px 가로 넘침을 수정·재검수했다. 기능 A는 아래 실행 범위에서 확인했으며 전체 AE-07/08은 PARTIAL이다. 2026-09-08.

## 기준과 담당

- 상위 [#746](https://github.com/jayleekr/hypeproof-studio/issues/746)의 두 세션 분담을 따른다.
- 구현: [PR #759](https://github.com/jayleekr/hypeproof-studio/pull/759), 제출 `f7afd4a76171e3774ecf2410438ab5057772b036`, base `fe6f7b5`.
- 검수 코드: `db615dee97e0d402eaf3b1b9e2d892ca471827fc`. 최초 baseline은 `6684bd1` (제품 base `7f41c104`).
- 입력창 수정: `bb6efac52d53a2aec1e16aae9930ff21b608dccf`; 재검수 코드 `939dab82e6fc7472d24fd9f1e94ce2fc64d1c7f1`.
- 설계: [293d4b5](https://github.com/jayleekr/hypeproof-studio/commit/293d4b5), PR #753. Lab 철학 `6845cdb4`를 포함하며 기존 P0 30개를 유지한다.
- Codex: 이 인수 문서, `e2e/lesson-studio/**`, 실제 화면·통합 판정. 브랜치 `chore/epic-746-review-a` (구현 #759를 base로 하는 검수 전용 PR).
- Claude: Chalk/Service/extension 구현·기존 단위/계약 테스트·필요한 schema ADR. 구현 파일 담당은 이동하지 않았다.

## 기능 A: 확정 수업의 고정 AI 이름

강사가 수업의 AI 표시 이름을 정해 확정하면 해당 버전의 학생이 같은 이름으로 대화한다.
합성 수업 A는 “제작 파트너”, B는 “검토 도우미”를 사용한다. 기존 profile `ux.coach`와
session-design/authoring→서명된 lesson→resolved profile→ChatPanel 경로를 재사용한다.
계약은 `hps-session-design/1`의 optional `assistant.display_name`이다. [ADR-0005](../adr/0005-lesson-assistant-identity.md)에 구버전 조합·배포 순서·rollback floor가 있다. 새 인증·별도 이름 저장소를 만들지 않는다.

첫 단위는 **고정 표시 이름 전달과 격리**다. 전체 AE-07/08 완료는 아니다. 역할 소개·말투·학생
작명 후보·과거 세션 identity·도구 승인/도움 공유 전면 반영은 해당 후속 단위로 남긴다.
모델 picker·SDK 세션 복구를 이 PR에 함께 넣지 않는다.

| ID | 인수 조건 | 근거 / 연결 |
|---|---|---|
| A1 | 강사 입력→저장→확정 버전→학생 권한 요청에서 같은 고정 이름을 받음. 확정 후 초안 이름 변경은 기존 학생에게 적용되지 않음 | Service 요청/응답의 비밀 없는 요약, lesson version/digest; AE-07, AE-T04 |
| A2 | 실제 Studio의 헤더·AI 발화 라벨·고정 이름 설명이 확정 이름과 일치하고 AI임을 알 수 있음. 고정 이름에서 학생 이름 편집을 열지 않음 | 실제 앱 화면·키보드; AE-07/08, AE-T04/05 |
| A3 | A→B→A와 재접속에서 다른 수업 이름/기존 개인 별명이 덮어쓰지 않음. 이름 변경으로 모델/도구 권한이 확장되지 않음 | 서로 다른 학생/수업 자격, effective profile 비교; AE-08/09 |
| A4 | 기존 schema/이름 미설정 수업은 기존 이름 동작을 보존. 새 schema를 모르는 클라이언트의 처리와 잘못된 이름의 오류를 설명 | 양성 기존 수업 + 미지원/잘못된 값 대조; AE-12, AE-T08 |
| A5 | 이름은 텍스트로 표시. 한글·공백·HTML 문자와 계약 상한의 긴 이름에서 실행/레이아웃 문제가 없고 390/1280px·200% 확대·키보드로 주요 행동에 접근 | 실제 렌더·보이는 영역·focus/대비 기록; AE-06, AE-T03/05 |
| A6 | 전송 실패/Stop 뒤 학생 입력과 수업 이름을 보존. 새 이름을 과거 실행의 이름으로 고쳐 쓰지 않는 범위를 명시 | 실패/재개 화면, 기존 보존 계약; AE-03/08 |

## 코드에서 확인한 시작점

최초 baseline의 session-design/1은 정확한 필드 목록만 받으며 수업별 AI 이름 필드가 없다.
lesson-delivery는 서명된 버전/digest를 재확인한다. ChatPanel은 profile의 fixed 이름을 개인
별명보다 우선하지만 헤더 설명에는 “이 수업의 코치”가 고정돼 있다. 따라서 profile 이름 표시를
처음부터 다시 만들지 않고 **강사 수업 설정과 확정 전달의 빈 경로**를 구현한다.

기존 `e2e/lesson-studio/mac.mjs`는 합성 강사/학생의 실제 Service→앱 수업 표시와 과제 입력을
검증한다. 모델을 호출하지 않는 이 검사는 A의 전달 검수 기반이며 AI 발화·도구/실패·재개 검사를
대신하지 않는다. 먼저 이 경로의 현재 상태와 로드한 코드·화면을 확인한다.

## 실행 결과와 다음 인계

[직접 촬영한 화면·환경·판정](../research/agent-experience-acceptance-2026-09-08/README.md).
판정은 실제 설치 앱의 별도 사본 + 후보 확장 + 로컬 Service/SQLite + 합성 수업에 한정한다.
AI 응답은 실제 Agent SDK→Anthropic이며, 오류 400과 응답 지연은 테스트가 주입했다.

| 범위 | 상태 | 남은 조건 |
|---|---|---|
| 최신 철학·AE 추적 | PR #753 반영 | 인간의 학습 효과는 미검증 |
| 현재 Service→앱 baseline | PASS | 수업 표시·과제 입력만, 모델 호출 없음 |
| A1 | PASS — Service 전달 + 별도 Chalk 브라우저 저장/확정 | 실제 강사의 수업 작성 리허설 |
| A2 | PASS — 헤더·title·답변 라벨·실제 응답·AI 고지 | 모든 이름 표면·스크린리더는 미검증 |
| A3 | PARTIAL — 같은 사용자의 A→B→A/동일 코드 재연결, 별명 우선순위, 권한 불변 | 앱 재시작·과거 정체성 보존은 미검증. 과거 답변 라벨이 현재 이름으로 바뀌는 것은 실제 관측 |
| A4 | PARTIAL — 기존 수업 기본 이름 및 25개 Service 계약 검사 PASS | ADR의 구버전 앱/Service 표는 실제 조합을 실행한 결과가 아님 |
| A5 | 폭 수정 재검수 PASS — 390/1280px 문서 폭 일치, 넘친 요소 없음 | 200% 확대·Tab→Clear도 재확인; 전체 키보드 동선/대비 판정 아님 |
| A6 | PARTIAL — 400/Stop에서 보낸 요청·미전송 후속 입력·현재 이름 보존 | 503 자동 복구·과거 실행 정체성은 미검증 |
| D0~D4 전체/AE-T36 | NOT RUN | 실제 모델/도구/검수/복구/공유/재열기 연결 |

다음 인계: Codex가 스타일 한 선언의 담당 이전을 먼저 기록하고 `bb6efac`로 수정·재검수했다.
Claude의 B에는 동일 선언을 중복 적용하지 않도록 수정 SHA를 인계한다. [기능 B 인수 조건](agent-experience-feature-b.md)의 승인·시작·관찰 등 이름 표면과 E7의
실제 모델 표시는 각 후보 제출 이후 별도 검수한다. 전체 AE-07/08 완료로 닫지 않는다.

## 재현 조건

검수 checkout은 `db615dee97e0d402eaf3b1b9e2d892ca471827fc`에 고정하고 Worker/Chalk/e2e/extension
의존성을 설치한다. extension/webview만 빌드해 설치 앱 **사본**에 주입한다. 기존 native trial
스크립트의 복사·주입 절차를 재사용하며 다른 세션이 쓰는 앱/8787 서버를 종료하지 않는다.
아래 `HPS_APP_PATH`는 원본 설치 앱이 아닌 검수용 사본의 실행 파일이다.

```bash
export HPS_ACCEPT_SOURCE="/absolute/path/to/review-checkout"
export HPS_ACCEPT_PRIMARY="/absolute/path/to/primary-clone"
export HPS_APP_PATH="/absolute/path/to/test-copy/HypeProof Studio.app/Contents/MacOS/HypeProof Studio"
export HPS_LESSON_BUNDLED_EXTENSION=1
export HPS_LESSON_IDENTITY=1
export HPS_LESSON_LIVE=1
export HPS_LESSON_EXPECT_SHA=db615dee97e0d402eaf3b1b9e2d892ca471827fc
export HPS_LESSON_PRODUCT_SHA=f7afd4a76171e3774ecf2410438ab5057772b036
export HPS_LESSON_EVIDENCE_DIR="$HPS_ACCEPT_PRIMARY/e2e/test-results/agent-experience/new-run"
cd "$HPS_ACCEPT_PRIMARY/e2e"
node --env-file="$HPS_ACCEPT_PRIMARY/worker/.dev.vars" \
  --experimental-strip-types --experimental-sqlite \
  "$HPS_ACCEPT_SOURCE/e2e/lesson-studio/mac.mjs"
```

원본 로그는 gitignored run 디렉터리에, 검토한 합성 화면·비밀 없는 요약은 위 증거 문서에 남긴다.
수정 후 폭만 재현하려면 checkout/`HPS_LESSON_EXPECT_SHA`를 `939dab82e6fc7472d24fd9f1e94ce2fc64d1c7f1`,
`HPS_LESSON_PRODUCT_SHA`를 `bb6efac52d53a2aec1e16aae9930ff21b608dccf`, `HPS_LESSON_LIVE=0`으로
설정하고 그 checkout의 webview를 다시 빌드·주입한다. 실제 모델/400/Stop 결과는 원본 실행에 남아 있다.
Service 키는 앱 자식 프로세스에서 제외한다. 원문 토큰/키·학생 데이터는 기록하지 않는다.
디버그 포트 9347 충돌은 해당 실행을 시작하지 않고 해결한다. baseline 통과를 후보 기능 PASS로 쓰지 않는다.

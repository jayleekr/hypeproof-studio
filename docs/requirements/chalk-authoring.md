# Chalk 수업 작성 요구사항

상태: 구현 목표. 이 문서는 구현 완료나 배포 증거가 아니다.
범위: 치과의사 대상 정적 HTML/CSS/JavaScript 홈페이지 수업.
P0 = 첫 수업 필수, P1 = 정규 과정, P2 = 확장 단계.

## 기준과 현재 구현

[기존 Studio 계약](../studio-requirements.md)을 대체하지 않는다.
아래 ID는 이 문서에 한정된 식별자이며 [테스트 계획](../testing/chalk-authoring.md)에서 참조한다.
Chalk console/issuer/board, Service 인증, live-server, module envelope는 재사용 후보다.
작성 UI·학생 모드 리허설·수업 고정 버전은 이 문서만으로 구현됐다고 판정하지 않는다.

## Acceptance requirements

| ID | 요구사항 및 관측 가능한 인수 기준 | 우선순위 |
|---|---|---|
| BASE-01 | 강사·수강생 역할에 따라 화면과 권한을 구분한다. | P0 |
| BASE-02 | Chalk에서 수업 설계·구성·리허설·운영을 제공한다. | P0 |
| BASE-03 | 기본 홈페이지 실습은 명령어·설정 파일 편집 없이 수행한다. | P0 |
| BASE-04 | 안내·예제·도구·AI 지침·완료 기준을 하나의 수업 구성으로 저장한다. | P0 |
| BASE-05 | 수업 종료 후 자기 프로젝트를 열고 수정한다. AI와 호스팅 이용 조건은 별도 표시한다. | P0 |
| CH-01 | 대상·시간·목표·선수 조건을 저장하고 재편집한다. | P0 |
| CH-02 | 예제·실습·검수 항목을 갖춘 홈페이지 수업을 생성한다. | P0 |
| CH-03 | 시작 예제를 학생별 독립 사본으로 제공하고 원본을 보존한다. | P0 |
| CH-04 | 단계별 안내·힌트·완료 기준과 순서를 편집하고 학생에게 표시한다. | P0 |
| CH-05 | 강사가 선택한 제작 기록으로 수업 초안을 생성하고 직접 확정한다. | P1 |
| CH-06 | 기본·확장 과제를 같은 수업에 구성한다. | P1 |
| CH-07 | 학생 데이터 없이 수업 자료와 구성을 다음 기수에 복제한다. | P1 |
| WEB-01 | AI와 홈페이지를 생성·수정하고 기존 프로젝트를 이어간다. | P0 |
| WEB-02 | 문구·사진·진료시간을 변경하고 자료를 프로젝트에 보존한다. | P0 |
| WEB-03 | 실행 환경을 준비하고 포트 입력 없이 실제 미리보기를 연다. | P0 |
| WEB-04 | 모바일·데스크톱 화면 너비를 전환해 배치와 동작을 확인한다. | P0 |
| WEB-05 | 파일 추가·수정·삭제를 포함한 이전 상태로 복구한다. | P0 |
| WEB-06 | 검사 범위를 명시하고 링크·이미지·실행 오류를 찾아 위치를 보여준다. | P0 |
| WEB-07 | 검증된 배포 경로로 공개 URL을 만들고 재접속해 확인한다. | P0 |
| WEB-08 | 이전 배포를 선택해 공개 버전을 복구한다. | P1 |
| WEB-09 | 지원하는 웹앱 템플릿의 의존성 설치·빌드·실행·오류 표시를 제공한다. | P1 |
| ENV-01 | 가능한 작업 중심으로 기능 목록과 계정 필요 여부를 보여준다. | P0 |
| ENV-02 | 도구 설치와 실제 예제 실행을 함께 확인한다. | P0 |
| ENV-03 | 검증한 도구·예제·설정 버전을 수업에 고정한다. | P0 |
| ENV-04 | 학생별 인증을 분리하고 예제와 수업 복제에서 제외한다. | P0 |
| ENV-05 | 검증된 플러그인·MCP를 연결 시험 후 추가한다. | P1 |
| ENV-06 | 미등록 도구를 별도 환경에서 시험하고 수업 적용을 검토한다. | P2 |
| ENV-07 | 지원 OS·아키텍처·최소 앱 버전·네트워크·계정 조건을 명시한다. | P0 |
| RUN-01 | 강사 전용 권한 없이 학생 조건으로 리허설한다. | P0 |
| RUN-02 | 실행·자료·도구·인증별 준비 상태와 해결할 일을 표시한다. | P0 |
| RUN-03 | 수업 코드 또는 초대로 학생이 지정 수업과 자기 프로젝트에 진입한다. | P0 |
| RUN-04 | 학생 기기의 지원 여부·접속·AI 이용 가능 상태를 확인한다. | P0 |
| RUN-05 | 환경 오류 시 학생 작업을 보존하며 재시도·복구를 안내한다. | P0 |
| CLS-01 | 선택한 수업의 전체 학생 단계·제출·도움 상태를 보여준다. | P0 |
| CLS-02 | 학생이 공유 범위를 확인한 뒤 작업 맥락과 함께 도움을 요청한다. | P0 |
| CLS-03 | 학생 결과물의 대상 위치와 연결된 피드백을 제공한다. | P0 |
| CLS-04 | 학생 허용 후 강사가 수정하며 변경 이력·복구 지점을 보존한다. | P1 |
| CLS-05 | 학생이 선택해 공유한 결과물만 공동 리뷰에 표시한다. | P1 |
| EDU-01 | 실습마다 학생이 직접 판단할 목적·선택·검수 과제를 안내한다. | P0 |
| EDU-02 | 실습별 힌트·함께 수행·독립 수행 지침을 실제 AI 동작에 반영한다. | P1 |
| EDU-03 | 결과물과 변경 이유·검수 내용을 함께 제출한다. | P0 |
| EDU-04 | 시연과 다른 독립 과제와 도움 사용 범위를 기록한다. | P1 |
| EDU-05 | 직접 수행·도움받아 수행·전문가 위임으로 자립 범위를 정리한다. | P1 |
| REQ-01 | 수업·목적·필요 날짜·참고 링크를 포함해 지원을 요청한다. | P0 |
| REQ-02 | 요청 상태·담당자·다음 조치·예상 일정 또는 미정 사유를 표시한다. | P0 |
| REQ-03 | 기존 안내·선택 확장·기본 개발로 분류하고 이유를 전달한다. | P1 |
| REQ-04 | 강사가 실제 예제로 해결 여부를 확인한다. | P1 |
| ARC-01 | Chalk는 화면·전달, Service는 권한·상태 저장·토큰 서명을 소유한다. | P0 |
| ARC-02 | Studio에서 Chalk로 진입하며 인증을 URL에 넣지 않는다. 웹 진입과 내장 화면을 구분한다. | P0 |
| VER-01 | 수정 가능한 초안과 불변 확정 버전을 구분하며 진행 수업은 확정 버전을 참조한다. | P0 |
| VER-02 | 리허설 증거는 검사한 버전에 귀속되며 관련 변경 시 합격 상태를 무효화한다. | P0 |
| AUTH-01 | 신규 프로젝트 공유는 별도 권한 계약으로 설계한다. 기존 메타데이터 조회 권한을 원문 접근으로 확대하지 않는다. | P0 |
| SAVE-01 | 중복 요청·응답 유실·동시 편집에서 중복 생성과 조용한 덮어쓰기를 방지한다. | P0 |

### 커리큘럼 구성과 Studio 동작의 연결 · 2026-09-21

[TJ 제안의 제품 의도](../PRODUCT-INTENT.md#one-instructor-classroom-intent)에 따라
BASE-04·CH-01/04/06/07·ENV-01/03·EDU-02·VER-01/02를 하나의 작성 흐름으로 해석한다.
강사는 검증된 단계·예제·실습·AI 역할/도움·도구·완료 기준을 구성 단위로 조합하고,
고객 대상에 맞는 변형을 만든다. 바뀐 확정 커리큘럼은 Studio의 해당 기능과 역할에
반영돼야 한다. 문구 교체나 자료 복제만으로 이 목표를 완료했다고 하지 않는다.

초안 편집 → 변경 영향 확인 → 학생 조건 리허설 → 확정 버전 → 대상 배포 → 실제
학생 실행의 버전·기능 확인으로 이어진다. 진행 중 수업을 초안 수정으로 바꾸지 않고,
허용된 기능 카탈로그 안에서 구성하며 학생 데이터·자격은 커리큘럼 복제에서 제외한다.
“블록코딩처럼”은 구성 가능성의 의도이며 시각적 드래그 편집기가 이미 있다는 뜻은 아니다.
U3의 수업 버전 전환은 이 흐름의 전달 부분이다. 작성·리허설 전체의 완료 증거로 대신하지 않는다.
검증은 기존 [Chalk 테스트](../testing/chalk-authoring.md)와
[통합 인수](../testing/classroom-admin.md#one-instructor-acceptance)를 연결한다.

<a id="g2-curriculum-runtime-20260922"></a>

### G2 커리큘럼 → 실제 실행 연결 · 2026-09-22

위 흐름(초안 → 영향 확인 → 학생 조건 리허설 → 확정 → 대상 배포 → 실제 실행)을 한 경로로 구현했다.
U3의 전달·전환·turn snapshot 계약은 그대로 쓰고, 빠져 있던 작성·리허설·확정과 App 소비자를 채웠다.

| 단계 | 계약 (관측 가능한 기준) | 요구 |
|---|---|---|
| 편집·재사용 | `/authoring` 단계마다 **도움 방식**(시연·힌트·함께 수정·직접 해보기 중 허용 집합과 처음 값)과 **학생 작업 화면**(대화 · 확인 기준 양식 · 결정과 이유 양식)을 편집한다. 확정된 버전 전체나 단계 하나를 가져와 새 초안으로 고친다(Service가 만든 binding은 떼고, 학생 기록·명단·코드·사용량은 가져오지 않음). 이 Studio가 그리지 못하는 `ui` 값은 이름을 붙여 보존하고 새로 고르게 하지 않는다 | BASE-04, CH-01/04/07, EDU-02 |
| 영향 확인 | Service가 두 버전(또는 버전과 저장한 초안)을 비교해 대상·목표·예제, 단계 추가/삭제/순서, 단계별 문구·도움 방식·작업 화면, 허용 기능·모델·AI 이름의 차이를 돌려준다. 강사 화면은 이를 문장으로 보여 준다. AI 이름 변경은 이름만 바뀐다고 적는다 | BASE-02, VER-01 |
| 리허설 후보 | 초안 고정은 **리허설 후보**(불변 버전·sha256)를 만들 뿐 확정이 아니다 | VER-01 |
| 학생 조건 리허설 | 강사가 리허설 학생 ID(열린 연습 세션 명단에 등록된 ID — 실제 초대와 같은 입장 규칙)로 후보에 묶인 **학생 코드**를 발급한다. 강사 자격은 쓰지 않는다. 상태는 리허설 전 / 리허설 중(준비 완료 아님) / 기록 만료 / 통과 / 통과하지 못함(이유) / 지원 안 됨 / 다시 필요(정책 변경)로 나뉜다. 코드 발급·후보 고정·ping은 통과가 아니다 | RUN-01/02, VER-02 |
| 판정 | Studio가 그 코드로 실행해 **그린 것**(단계별 도움 선택지·처음 값·작업 화면)과 App·SDK·OS 식별을 보고하면, Service가 후보 내용과 **자기가 그 코드로 받은 요청 기록**(강의 digest·단계·도움 방식 영수증·요청이 실어 간 도구 이름·종료 결과)을 맞춰 한 번만 판정한다. 모든 단계를 열어 봤는지, 완료된 요청이 있고 현재 단계가 실렸는지, 허용하지 않은 쓰기·셸·검색 도구가 없고 허용한 쓰기 도구는 있는지 본다. 요청 전 보고는 판정하지 않는다(미실행) | RUN-01/02, ENV-03, EDU-02 |
| 무효화 | 판정은 (버전, sha256)에 묶인다. 리허설 중 저장한 초안은 다른 후보가 되어 아무것도 물려받지 않는다. 통과 뒤 프로필의 허용 기능·모델 binding이 바뀌면 `다시 필요`로 보이고 확정할 수 없다 | VER-02 |
| 확정 | 그 후보의 **최신·통과·현재** 리허설로만 확정한다. 한 번 쓰고, 진행 중 수업은 바뀌지 않는다 | VER-01/02 |
| 대상 배포 | Service 설정 `HPS_LESSON_CONFIRMATION=require`이면 참여 코드 발급과 U3 수업 설정 전환이 확정 버전만 받는다(수업 기본 버전으로의 복귀는 막지 않음). 설정이 없으면 오늘 동작 그대로이며 강사 화면은 확정 여부를 계속 보여 준다. 운영 활성화는 별도 결정이다 | ENV-03, VER-01 |
| 실제 실행 | App이 두 런타임 모두 현재 단계(`x-hps-lesson-step`)와 그 단계가 허용한 도움 방식(`x-hps-help-mode`)을 턴 시작 때 한 번 정해 보낸다. 학생이 저장한 기준·결정은 그 단계의 다음 턴에 학생의 말로 표시되어 함께 간다. 진행 중 턴은 시작 때의 수업으로 끝나고 다음 턴이 새 버전으로 간다(U3) | EDU-01/02, RUN-03 |

**경계**: 도움 방식과 작업 화면은 교수 전략·작업 표면이며 도구 권한을 바꾸지 않는다(권한은 프로필과
`features` 좁히기만). agent-sdk 경로의 도구 좁히기는 여전히 정상 클라이언트에 대한 계약이다(REQ-M38) —
리허설의 도구 판정은 **요청이 실어 간 도구 이름**을 기록할 뿐 조작된 클라이언트에 대한 Service 경계가 아니다.
시각적 블록 편집기, 나머지 다섯 작업 화면(`canvas_editor`·`canvas_preview`·`evidence_note`·`coach_request`·
`metric_board`)의 학생 화면, 여러 대상 변형의 일괄 관리, 확정 요구의
운영 활성화는 남은 작업이다. 보고서가 여러 수업 기준을 나눠 쓰는 일은 G3다 — 이 단계는 턴마다 강의 digest가
기록되는 기존 U3 식별을 그대로 둔다. 실행 기록은 [테스트 G2 기록](../testing/chalk-authoring.md#g2-run-20260922).

<a id="g2-mission-20260922"></a>

#### G2 인수 보정 — 미션 작성 → 학생 과제 표시 → 실행 · 2026-09-22

G2 첫 구현은 `learning` 블록을 보존만 했고 학생 화면은 "미션이 정해지지 않았습니다."를 보였다. 원래 요구(바뀐
커리큘럼이 학생의 미션·도움·도구·실행을 바꾼다, SX-01·SX-56)의 핵심 공백이라 같은 경로 위에 채웠다. 스키마·검증기는
기존 `worker/src/lib/learning-design.ts`(`week`·`mission` 필수, 나머지 선택) 그대로다.

| 단계 | 계약 | 요구 |
|---|---|---|
| 편집 | `/authoring` "이번 주 미션 · 완료 조건"에서 **주차·미션 문장·완료 조건(문장 + 근거가 되는 기록 종류 8가지 중 하나)**을 켜고 편집한다. 기록 종류 이름은 학생 쪽 `KIND_LABELS`와 같은 말이다. 끄면 `learning`을 보내지 않는다(기존 수업은 그대로). 제목·목표로 미션을 대신 만들지 않는다. 주차·미션·빈 조건·기록 종류 누락은 저장 전에 강사 말로 막고, Service 검증기(점수 금지 포함)가 최종 판정한다 | SX-01, SX-55/56/59, BASE-04 |
| 보존 | `observe`·`never`·`evidence_types`·`source_kinds`·`reflection`은 이 화면에 칸이 없다. 연 그대로 `learning` 안에 되돌려 넣고, 이름과 개수를 "그대로 보존하는 학습 설계 항목"으로 보인다. 저장·재열기·버전 전체/단계 재사용·내보내기/가져오기가 모두 같은 규칙이다. 미션을 끄면 보존 항목도 빠진다는 확인을 먼저 받는다 | SX-56, #1036 |
| 차이 검토 | Service `lessonImpact`의 `learning`이 주차·미션·완료 조건 변화와 보존 항목 중 바뀐 키를 돌려준다. 작성 화면과 운영 보드 보내기 확인이 "학생 미션: 미션 없음 → 1주차 ‘…’", "완료 조건: … → …"로 보인다 | BASE-02, VER-01 |
| 후보·확정 | 리허설 상태에 "이 후보의 학생 미션", 확정 확인창과 버전 목록·운영 보드 설정 선택지에 미션이 붙는다 | VER-01 |
| 리허설 | App 보고(`hps-rehearsal-report/1`의 선택 필드 `mission`)는 학생 화면 **MissionHeader DOM에서 읽은** 주차 줄·미션 문장·완료 조건 글이다. Service는 후보의 `learning`이 그려야 할 글과 글자 그대로 비교한다. 미션이 있는 후보에서 다르면 `mission_mismatch`, 읽어 보내지 않으면(이전 App) `mission_not_reported`로 통과하지 못한다. 미션 없는 후보는 `none` — 미션 관련 준비 판정을 하지 않는다. 판정은 여전히 (버전, sha256)에 묶여 리허설 중 미션을 고친 초안은 새 후보다 | RUN-01/02, VER-02 |
| 실행 | 코치 문맥은 기존 `learningInstruction`이 턴의 lesson(바인딩)에서 만든다 — 선택 학생의 다음 턴부터 새 미션, 진행 중 턴은 시작 때 미션, 비선택·미연결 학생은 그대로. 완료 조건은 학생 화면에서 모두 ☐이며 근거 이벤트 없이 ✓를 그리지 않는다(SX-01 P0 원칙 유지) | EDU-01, RUN-03, SX-01 |

**편집 지원 범위**: 편집 = `week`·`mission`·`completion[]`(id는 자동). 보존만 = `observe`·`never`·`evidence_types`·
`source_kinds`·`reflection`, 단계의 `evidence`·`gate`. 이들의 편집 칸(설계 문서 SX-56이 계획한 Chalk 필드)은 남은 작업이다.

<a id="g2-step-ui-matrix"></a>

**`steps[].ui` 지원 표** (설계 [studio-learning-experience.md](../design/studio-learning-experience.md) `steps[].ui` 7종 기준):

| 값 | 학생 Studio | Chalk 선택 | 리허설 | 쓰는 곳 |
|---|---|---|---|---|
| (없음) → 대화 | 그림 | 기본 | 판정 | 모든 기존 수업 |
| `criterion_form` | 그림(기준 저장 → 다음 턴 문맥) | 선택 | 판정 | Mac A, 6주 예시 3·5·6주차 |
| `decision_form` | 그림(결정·이유 → 다음 턴 문맥) | 선택 | 판정 | Mac B, 6주 예시 1·2·4·5·6주차 |
| `canvas_editor`·`canvas_preview`·`evidence_note`·`coach_request`·`metric_board` | "이 Studio에서 아직 열 수 없음" 안내 | 이름 붙여 보존만 | `unsupported`(확정 불가) | 6주 SX-56 **예시 픽스처**(`worker/test/fixtures/session-design/week-1..6.json`)와 설계 문서뿐 |

2026-09-22 기준 실제 구성된 과정(코호트 프로필, `docs/curriculum/`)에는 다섯 값이 쓰이지 않으며, 이번 A/B 범위도
필요로 하지 않는다. 그래서 새 소비자를 만들지 않고 `unsupported` 리허설(확정 불가)과 로드맵 상태를 유지한다. 6주 과정을
실제 수업으로 올릴 때 이 다섯 화면이 선행 조건이다. 범용 시각 블록 편집기는 여전히 로드맵이다.

## 첫 구현 경계

기본 예제 선택 → 초안 작성 → 준비 점검 → 학생 조건 리허설 → 수업 버전 확정 →
기존 참여 경로 연결을 먼저 구현한다. 자동 강의 생성·임의 MCP 설치·원격 수정은 후속이다.
전체 P0 출시와 첫 저장 API PR 완료는 다른 게이트다.

## Contract decision before implementation

[레이어 규칙](../plan/vessel-and-modules.md)과
[registry](../../products.yaml)를 따른다.
Service의 기존 hps-module/1 envelope 및 session-design kind를 우선 검토한다.
(첫 API 작성 당시 기록) 그때 session-design은 envelope 검증만 있고 소비자가 없었으므로 완성된 수업
schema로 취급하지 않았다. 지금은 `validateSessionDesign`·`readLesson`·chat gate·`/v1/profile`·Studio 단계 패널이
소비자다 — 현재 소비자와 빠진 소비자는 위 [G2](#g2-curriculum-runtime-20260922)에 적는다. 수업 콘텐츠와 정책 권한을 분리한다.

첫 구현 PR은 session-design content schema, 이전 클라이언트 호환, 잘못된 버전의
격리·오류 안내, 실행되는 계약 테스트, 제거·복구 방안을 함께 제시한다.
초안 동시 편집에는 저장소의 원자성 보장을 확인해야 한다. 기존 KV pin의 eventual
consistency를 낙관적 잠금이나 수업 인스턴스 고정 보장으로 간주하지 않는다.
새 저장소나 migration은 기존 모델 조사 후 결정한다.

Studio에서 Chalk에 접근하더라도 Chalk 웹 화면의 모바일 접근성을 유지한다.
수업 생성이 운영 세션 개설·토큰 발급·외부 공개를 자동으로 수행하지 않는다.

## Implementation progress

The Service draft/frozen-version API is implemented in [ADR 0004](../adr/0004-chalk-authoring-storage.md). Chalk `/authoring` now covers file import, draft/step editing, save/reopen and frozen-version viewing. Student delivery now signs a frozen course/version/content digest into a participant credential after checking owner, profile, roster and an open matching session. `/learn` and the Studio lesson panel display that snapshot; draft edits do not change an issued credential. Both LLM wire routes validate the same lesson digest and add its teaching content. A frozen lesson may now also NARROW two things the profile already granted: the model set (#795, [ADR 0006](../adr/0006-lesson-model-policy.md)) and the feature set (#748, [ADR 0007](../adr/0007-lesson-feature-binding.md)). Both are narrowing only, both are checked at save, at freeze and again on every read, and neither can grant anything the compiled profile withholds. `/authoring` offers each as a picker over a catalogue derived from that cohort's own profile. How far the feature narrowing is actually enforced differs by route and is stated in REQ-M38 rather than assumed here. Rehearsal evidence, settings pins and activation remain planned. Support requests open an unsubmitted GitHub draft; this does not implement an internal request queue. Freezing stores an unverified snapshot, not a deployable class.

## Simplified instructor entry (local implementation)

The instructor supplies a token and selects a server-returned profile display name.
The token payload is used only to discover candidate cohorts; the existing `/state`
authorization remains authoritative. Course IDs are generated for new drafts and
version IDs for freeze. Manual IDs, imports, AI policy and student delivery remain
under optional details. Draft edits, conflict handling and inactive frozen versions
keep the existing CH-01 / SAVE-01 / ARC-01 contract. Clearing the displayed setting
also clears its hidden cohort/profile binding and blocks create/save until a verified
setting or manual target is selected, while preserving the in-progress curriculum.
This does not implement AI
generation, new cohort provisioning, persistent login or independent course storage.

2026-09-22: the authoring page carries the shared instructor flow bar (prepare → run → wrap up) from the
[instructor UI pass](classroom-design.md#instructor-ui-pass-20260922). Layout and contracts of the page are unchanged.
The same day's [second pass](classroom-design.md#instructor-ui-pass2-20260922) only moved the bar's help link from wrap-up to "2 수업 진행"
(`/manage#ops-help-title`); the authoring page itself is unchanged.

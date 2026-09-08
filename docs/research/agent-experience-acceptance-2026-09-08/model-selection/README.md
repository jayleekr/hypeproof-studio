# 수업 허용 모델 선택 — 실제 Mac·Chalk·공급자 검수

2026-09-08, #792 / #795 / E7 #755 / Epic #746. 사용자 우선순위는 **입력창에서
모델을 선택하고 다음 요청부터 바꾸는 것**이다. 답변별 상시 배지는 추가하지 않았다.
강사는 기존 Chalk 편집에서 코호트 허용 목록의 일부와 기본값을 수업 버전으로 확정한다.

## 확인한 결과

| 실제 실행 | 고정 SHA | 확인한 범위 |
|---|---|---|
| [SDK](sdk/model-selection-result.json) | `73136dc` | 9개 모델을 같은 대화에서 순서대로 사용. 실제 API 18회 모두 선택한 모델·HTTP 200. 모델 변경 중 이전 턴 모델 유지·미전송 초안 보존·꽃집 이름 문맥 유지 |
| [proxy](proxy/model-selection-result.json) | `b4ac941` | 같은 9개 모델, 실제 API 9회 모두 선택한 모델·HTTP 200. 같은 UI/대화 전환 대조 |
| [고정 수업 화면 재검수](fixed-visual/model-selection-result.json) | `d15e7ac` | 다른 수업에서 고정 기본값으로 초기화·메뉴 비활성·고정 이유 표시. 모델 호출/키보드/AX는 이 실행에서 하지 않음 |
| [Chalk](chalk/run.log) | `8b177e4` | 실제 Chromium→Chalk→Service/SQLite. 9개 목록·Sonnet 5 기본값 저장/재열기/확정. 후속 Opus 5 고정 초안이 이전 버전을 바꾸지 않음 |

모델은 Sonnet **4.5 / 4.6 / 5**, Opus **4.5 / 4.6 / 4.7 / 4.8 / 5**, Haiku **4.5**다.
각 실제 ID는 [SDK 호출](sdk/api-evidence.json), [proxy 호출](proxy/api-evidence.json)과
각 `gateway-evidence.json`의 요청 선택을 대조한다. 이름을 화면에 표시한 것만으로
실제 모델을 판정하지 않았다. 모든 모델의 실제 마지막 답변에 앞서 알려준 `민트플라워`가
있음을 확인했다. SDK 보조 요청은 요청 시작 시 귀속하고 응답 도착까지 기다린다.

확장/webview는 기존 **0.1.51 Mac arm64 셸의 격리 사본**에 넣었다. 각각의 environment.json에
제품/검수 SHA, 번들 해시, SDK 버전/해시, 로컬 Service 출처가 있다. SDK/proxy 비교는
합성 `studio-native-trial` 프로필의 실행기를 각각 지정했다. 운영 데이터/설치 앱은 변경하지
않았으며 새 전체 앱 빌드나 운영 배포 결과가 아니다. `73136dc` 이후 `b4ac941`은 main의
PR 준비 도구만 합쳤고, `d15e7ac`까지 추가 변경도 검사기뿐이다. 제품 소스는 동일하다.

현재 확장 목록을 허용하는 compiled 프로필은 **성인 체험 `studio-native-trial`**이다.
다른 코호트는 기존 기본/예비 모델 범위를 유지한다. legacy default/fast/strong 핀을 바꾸는
#690의 전체 수업 이행은 완료하지 않았다. 새 수업 정책의 요청은 SDK fast/직접 ID도 허용
집합으로 제한한다. 모델/공급자/실행기 binding 변경 시 이전 수업 버전을 거부하는 Service
양/음성 검사는 합성 upstream을 사용하며 이 표의 실제 공급자 실행과 구분한다.

## 직접 연 화면

- [Chalk 390px](chalk/model-choice-390.png), [1280px](chalk/model-choice-1280.png): 9개 모델·학생 선택·기본 모델·버전 고정 설명을 읽을 수 있다.
- [실제 앱 390 CSS px](sdk/model-390.png), [1280px](sdk/model-1280.png), [200% 확대](sdk/model-zoom-200.png): 입력창의 모델명/선택 이유가 가로 잘림 없이 보인다. 390은 Mac editor의 최소 창 폭 400px 때문에 **실제 Studio zoom 200%**로 만들었고, 1280은 100%다. 메시지 영역은 세로 스크롤한다.
- [키보드 선택](sdk/model-keyboard-selection.png): ArrowDown으로 Haiku 선택. 실제 AX의 combobox 이름은 `대화 모델`, ignored=false. SDK/proxy 양쪽 실행에서 확인했다.
- [Haiku로 이어진 대화](sdk/model-switched-conversation.png), [Sonnet 5](sdk/claude-sonnet-5.png), [Opus 5](sdk/claude-opus-5.png), [proxy Opus 5](proxy/claude-opus-5.png): 기존 대화와 현재 선택이 함께 보인다.
- [고정 수업](fixed-visual/model-fixed.png): Sonnet 4.6 비활성 메뉴와 `이 수업에서 고정한 모델`을 확인했다.

원본 `visual_review: PENDING`은 수정하지 않았다. 후속 시각 판정은 이 문서와
[capture.json](capture.json)에 기록한다. `sdk/model-fixed.png`는 DOM 판정 직후의
**빈 전환 화면**이라 시각 근거로 부적합하다. 원본을 남기고 paint 이후의 별도 실행으로
재검수했다. 나머지 위 화면도 직접 열어 확인한 범위만 판정한다.

## 실패와 수정도 보존

1. [첫 SDK 실패](sdk-haiku-failure/model-selection-result.json): Sonnet→Haiku 선택은 전달됐으나 `thinking: adaptive`가 API 400을 만들었다. 실제 실패 화면과 호출 기록을 보존했다. Haiku의 미지원 adaptive만 제거하고 명시적 manual budget은 보존한 뒤 [첫 SDK 성공](sdk-first-pass/model-selection-result.json)·[첫 proxy 성공](proxy-first-pass/model-selection-result.json)을 확인했다.
2. [editor 폭 실패](editor-width-failure/model-selection-result.json): 실제 최소 창 폭 400을 무시한 검사였다. 제품의 최소 폭을 바꾸지 않고 실제 zoom 설정으로 390 CSS px를 관측하도록 수정했다.
3. `keyboard-*-failure`는 원래 select의 Mac 입력 문제를 좁힌 기록이다. [포커스된 검사](keyboard-focused-failure/model-selection-result.json)에서도 선택이 바뀌지 않았다. 키보드 이벤트의 전파/선택을 컨트롤 내부에서 처리한 제품 `e87d095` 뒤 실제 키보드/AX가 통과했다. 이후 [layout 실행](layout-interference/model-selection-result.json)은 도중 입력/포커스 간섭으로 실패했으며 성공으로 바꾸지 않았다. 이미 통과한 키보드를 반복하지 않고 마지막 고정 화면만 별도 검수했다.
4. [보조 호출 귀속 실패](auxiliary-attribution-failure/model-selection-result.json): 실제 요청은 모두 API 200이었으나 앞선 Sonnet 5 보조 응답이 늦게 도착해 다음 모델로 잘못 집계됐다. 요청 시작 시 기록하고 시작된 호출의 응답을 기다리는 `73136dc` 검사기로 9개 모델을 다시 실행했다. 기존 실패 파일은 그대로다.

[Models API 목록](models-api-list.json)과 [모델별 기능](models-api-capabilities.json)은 개발
계정의 실제 읽기 응답이다. [공식 모델 ID](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions),
[thinking 호환](https://platform.claude.com/docs/en/build-with-claude/extended-thinking?q=thinking)과
대조했다. API 기능 메타데이터를 Studio의 도구·권한 실기 증거로 간주하지 않는다.

## 재현 및 아직 하지 않은 일

기존 `e2e/chalk-authoring/run.mjs`에 `HPS_CHALK_MODEL_SELECTION=1`, 기존
`e2e/lesson-studio/mac.mjs`에 `HPS_LESSON_MODELS=1`, `HPS_LESSON_MODEL_RUNTIME=agent-sdk|proxy`,
`HPS_LESSON_LIVE=1`을 사용한다. 격리 앱에 후보 bundle을 넣고 expected/product SHA를
고정한 뒤 primary clone의 e2e에서 실행한다. 공급자 키는 로컬 Service에만 전달한다.
`HPS_LESSON_MODEL_LAYOUT_ONLY=1`은 live 없이 고정 화면을 재검수하는 범위다.

Windows, 스크린리더 발화, 전체 접근성, 모든 모델의 긴 코드 출력·도구/브라우저/Computer Use,
파일 복구·수업 운영 부하·실제 사람의 학습 효과는 **NOT_RUN**이다. 이번 9개 대화 전환을
모델 전체 능력 행렬이나 전체 E7 완료로 부르지 않는다. 새 모델/수업 조합의 리허설은 별도다.
[effort·강의료 포함 사용량 설계](../../../design/model-effort-and-course-usage.md)는 #799/#800의
후속 제안이며 이번 PR은 effort 선택 UI·과금/예산 원장을 활성화하지 않는다.

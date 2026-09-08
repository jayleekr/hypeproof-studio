# 기능 B 실제 앱 인수 — 현재 이름을 작업 표면까지 연결

2026-09-08. #746 / #747 / 구현 #765. **검수 진행 중이며 전체 인수 PASS가 아니다.**
원본 실패, 입력/실행기 수정, 제품 수정의 근거를 서로 다른 실행으로 보존한다.
인수 계약은 [B1–B6](../../../testing/agent-experience-feature-b.md)이다.

## 환경과 재현

실제 Mac Studio 0.1.51의 격리 사본에 제출 후보의 확장/webview를 빌드해 넣었다.
앱 셸은 기존 `d4db9049`이며 새 앱 릴리스가 아니다. 로컬 Service의 실제 authoring/profile
경로로 합성 확정 수업을 연결하고, 별도 임시 작업 폴더에서만 파일을 생성했다.
제출 제품 SHA와 제품 소스 diff, 검수 SHA와 실제 앱에 넣은 bundle 해시를 실행 전에 확인한다.
`environment.json`은 그 실행의 원본이다. 설치 앱·운영 DB·실제 수업·배포는 변경하지 않았다.

기존 [Mac 실행기](../../../../e2e/lesson-studio/mac.mjs)를 primary clone의 `e2e/`에서 실행한다.
`HPS_LESSON_SURFACES=1`, `HPS_LESSON_BUNDLED_EXTENSION=1`, 실제 앱 사본의 `HPS_APP_PATH`,
고정된 `HPS_LESSON_EXPECT_SHA`/`HPS_LESSON_PRODUCT_SHA`와 별도 evidence 경로가 필요하다.
`HPS_LESSON_LIVE=1`은 로컬 Service가 실제 Anthropic API를 사용한다. 키는 앱에 전달하지 않는다.
파일 승인 검수는 격리 사용자 설정에 `writeFile`을 명시적으로 추가했다. 제품 기본값은 작업
폴더 내 파일 자동 저장이므로, 이 결과를 모든 수업의 파일 승인 기본 정책으로 해석하지 않는다.

## 보존한 실패와 그 의미

| 실행 | 제품 / 검수 SHA | 실제 관찰과 판정 |
|---|---|---|
| [original-layout](original-layout/capture.json) | `2dfd99b` / `62fb269` | **제품 FAIL.** 유효한 40자 이름이 1140px 시작 화면에서 카드 밖으로 나가고 단계 설명과 겹침. 여기서 중단하여 도구·공급자 호출 없음 |
| [model-refusal](model-refusal/capture.json) | `2dfd99b` / `2821766` | 원래 레이아웃 FAIL을 유지하고 독립 검수 계속. 실제 모델이 `identity-proof` 파일 요청을 수업 밖 요청으로 거절하여 승인 모달 없음. B2 통과 아님 |
| [first-tools](first-tools/capture.json) | `2dfd99b` / `780d274` | 가상 꽃집 영업시간 파일로 입력을 바꿈. 실제 저장 모달 거절→파일 없음, 재요청 허용→정확한 내용 생성 PASS. 이후 `pwd`의 모달을 기대한 **실행기 전제 오류**로 중단 |
| [name-wrap-fix](name-wrap-fix/capture.json) | `ab92c2c` / `52b6af7` | 원래 긴 이름 결함 수정. 시작 후 제목/버튼도 실제 1280/390px 폭과 문서 폭 일치. 390px 패널→200% 확대의 실제 220px 패널에서는 상단 브랜드 영역이 284px까지 넘쳐 **FAIL 유지** |
| [sdk-tools](sdk-tools/capture.json) | `ab92c2c` / `52b6af7` | 실제 저장 거절/허용, `Bash(pwd)`, 작업 기록 18건을 끝까지 실행. user·approval denied/allowed·tool_result error/success 구분 및 평가 동의 false 확인. 전체 결과는 별도 상단 넘침 때문에 FAIL |
| [invalid-sdk-fixture](invalid-sdk-fixture/capture.json) | `ab92c2c` / `c3708a3` | vendored SDK만 제외했으나 앱의 별도 bare SDK로 `/v1/messages` 실행됨. **SDK 부재 fixture 성립 안 함**, B4 통과 아님 |
| [sdk-unavailable](sdk-unavailable/capture.json) | `ab92c2c` / `177e18c` | 앱 사본의 vendored/bare SDK를 모두 제외한 뒤 실제 `/v1/chat/completions`와 이름이 포함된 제한 안내 확인. 검사 후 두 SDK 복원. B4 텍스트/경로 PASS이나 안내 말줄임의 복구 지침 접근은 아래 미완료 |

첫 실행의 `surfaces-result.json`은 중단 당시 `IN_PROGRESS` 그대로이며 상위
`identity-result.json`의 FAIL을 적용한다. 후속 실행의 실패도 수정하거나 삭제하지 않았다.
자동 파일의 `visual_review: PENDING`은 생성 시점의 값이다. 이후 직접 이미지를 열어 한 검수는
아래 기록에 한정하며 실제 학습자의 평가로 표현하지 않는다.

- [원래 긴 이름 결함](original-layout/b-start-long.png): Codex가 직접 열어 카드 밖 문장과 단계 간 겹침 확인.
- [실제 모델 거절](model-refusal/b-failure.png): 답변은 거절인데 `✍️고쳤어요` 완료 표시가 보임. 효과와 상태가 어긋나는 **별도 E1 후속 결함**이다.
- [실제 저장 거절 직전](first-tools/b-write-deny.png): 현재 이름, Write 대상, 저장/Cancel 버튼이 보임. `Cancel`은 기존 앱 셸 문구다.
- [실제 저장 허용 직전](first-tools/b-write-allow.png), [저장 결과](first-tools/b-write-complete.png): 파일의 실제 존재/내용 판정은 같은 실행의 `surfaces-result.json`에 있다.

`pwd` 자동 실행은 `evaluateSdkToolUse`가 비파괴 셸 명령을 자동 허용하는 기존 정책과 일치한다.
일반 셸 모달 이름 변경을 이 실제 SDK 실행으로 검증할 수 없으므로 그 표면은 NOT_RUN이다.
모달을 띄우려고 테스트 전용 host event나 더 위험한 명령을 주입하지 않는다. 도구 권한은 이름이
아닌 Service/SDK 정책에서 결정한다는 요구사항을 유지한다.

## 수정 후 실제 화면과 남은 한계

Codex가 [390px 계속하기](name-wrap-fix/b-continue-390.png)와
[좁은 패널의 200%](name-wrap-fix/b-continue-zoom-200.png)를 직접 열었다. 이름을 포함한
카드와 버튼은 줄바꿈되지만 확대 시 패널의 상단 브랜드가 가로 폭을 초과한다. 이 조합은
390px 화면을 다시 확대해 CSS viewport가 220px가 된 경우이며, 이를 “390px에서 실패”로
혼동하지 않는다. Tab으로 “다른 수업에 연결”에 도달했고 그 버튼은 보였다.

[작업 기록 소개](sdk-tools/b-observation.png)를 열어 현재 이름과 18건, 미확인 상태,
평가 동의가 꺼진 상태를 확인했다. 실제 이벤트의 원문은 같은 실행의 `surfaces-result.json`에
보존했다. 이 이미지는 이벤트 상세가 접힌 순간의 캡처여서 **상세 행의 가독성 PASS가 아니다**.
실행기에서 펼친 뒤 브라우저가 그릴 시간을 확보하고 별도 상세 화면을 추가할 예정이다.
평가 API 요청이나 능력 판정은 하지 않았다.

[SDK 부재 안내](sdk-unavailable/b-sdk-unavailable.png)는 현재 이름과 제한 안내를 표시한다.
다만 긴 `hps-tool-label`이 한 줄 말줄임되고 별도 펼치기 동작이 없어 “스태프를 불러주세요”까지
화면에서 읽을 수 없다. B4 전체 UI를 PASS로 만들지 않고 표시 수정/재검수를 #765에 전달했다.
원본 자동 `B4: PASS`는 DOM의 텍스트와 실제 proxy 경로 확인이며, 시각 판정은 **PARTIAL**이다.

## 디자인·요구사항으로 되돌릴 내용

1. 강사가 설정할 수 있는 이름은 문장, 제목, 버튼에 들어가는 외부 입력이다. 최대 길이와 한국어 조사뿐 아니라 시작 전/후·좁은 패널·확대 상태를 검수한다.
2. 수업 정책에 없는 모달을 일률적으로 기대하면 실제 동작을 잘못 판정한다. RBAC, 허용 capability, 학생 확인, 실행된 효과를 각각 기록한다.
3. AI 응답 완료와 파일 변경 성공은 다르다. 거절한 요청에 `고쳤어요`가 나오지 않도록 실제 도구 결과와 연결하는 E1 작업이 남아 있다.
4. 이름, 실제 모델, 과거 실행 주체를 분리한다. 관찰 기록의 `coach` 이벤트 종류와 고지의 일반명사 “AI 코치”는 남아 있으며, 제품 전면의 “코치 제거” 완료가 아니다.

Windows, 스크린리더, 모든 승인 종류, Browser/Computer Use, 과거 identity, 실제 모델 선택,
D0–D4/AE-T36와 사람의 학습 효과는 이 기능 B 검수로 완료되지 않는다.

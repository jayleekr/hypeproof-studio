# Epic #746 실제 앱 검수 — 기능 A

2026-09-08. **후보 `f7afd4a`에서 발견한 6px 넘침을 `bb6efac`에서 수정하고 실제 앱으로 재확인했다.**
아래 원본 실패 증거는 유지한다. [수정 후 결과](#입력창-수정-재검수)는 390/1280px 모두 PASS다.
고정 이름 전달·실제 모델 응답·수업 전환·오류/Stop 후 입력 보존은 아래 실행 범위에서 통과했다.
이름 설정 전체, 전체 E1 또는 학습 효과가 검증됐다는 뜻은 아니다.

## 무엇을 실행했는가

최신 main 통합 결과는 [main-integration/capture.json](main-integration/capture.json)에
별도 저장했다. 제품 `9d0a4ad`, 검수 `cca993d`, 실제 앱의 10개 실행 항목 PASS다.
새 [390px](main-integration/long-name-390.png), [1280px](main-integration/long-name-1280.png),
[200%/키보드 포커스](main-integration/long-name-zoom-200.png) 이미지를 직접 열어
채팅 영역을 확인했다. 문서 폭은 390/1280, 이름과 버튼 겹침 없음. 200% 오른쪽 시작
화면의 잘림은 전체 접근성 PASS에 포함하지 않는다. 실제 모델·실패/Stop 재실행은 없었다.
같은 폭 수정은 #760으로 main에 포함되어 #762를 중복으로 닫았으며 아래 최초 결함·수정
실행의 SHA와 이미지는 그대로 유지한다. 새로운 이미지 3장과 기존 10장은 다른 실행의 근거다.

- 구현: [PR #759 / f7afd4a](https://github.com/jayleekr/hypeproof-studio/pull/759), base `fe6f7b5`.
- 검수 코드: `db615dee97e0d402eaf3b1b9e2d892ca471827fc`. 제품 소스는 제출 SHA와 동일한지 실행 전에 대조했다.
- 설계: [293d4b5 / PR #753](https://github.com/jayleekr/hypeproof-studio/pull/753), Lab 철학 `6845cdb4`.
- 실제 설치된 macOS Studio 0.1.51의 **별도 사본**에 후보 extension/webview를 빌드해 주입했다. 셸은 `d4db9049`, 확장·Service는 제출 후보다. 새 앱 릴리스 빌드가 아니다.
- primary clone의 `e2e/`에서 실행. 합성 강사·학생, 로컬 Hono Service와 SQLite/KV, 서명된 확정 수업을 사용했다. 실제 교실·운영 DB를 쓰지 않았다.
- `/v1/messages` 경로의 실제 Agent SDK 요청과 Anthropic 200 응답을 기록했다. 응답에 수업 이름이 들어가는 한 턴이며, 브라우저 도구·파일 수정·학습 성과 검증은 아니다.
- 원본 run: `e2e/test-results/agent-experience/20260908T154830Z-feature-a`. 이 폴더에는 비밀 없는 JSON 요약과 직접 열어 확인한 화면 7장을 보존했다. 토큰 입력 중에는 촬영하지 않았으며 이미지를 편집하지 않았다.

[환경](environment.json), [사례 판정](identity-result.json), [실제 API 요청](api-evidence.json),
[Gateway 경로·합성 오류](gateway-evidence.json), [이미지 해시](capture.json).
`identity-result.json`의 `visual_review: PENDING`은 자동 실행 종료 시점의 원본 값이다.
이후 Codex의 화면 검토 기록은 이 문서와 `capture.json`이다. 사람 학습자의 검수로 표현하지 않는다.

## 화면과 판정

| 관찰 | 판정과 범위 | 화면 |
|---|---|---|
| 강사가 고정한 “제작 파트너”가 헤더·답변 라벨·실제 응답에 표시 | PASS. 학생의 기존 “연습 코치” 별명보다 확정 이름 우선. AI 고지는 유지됨 | [실제 응답](a-live-answer.png) |
| A→B→A 및 같은 코드 재연결 | 현재 이름 PASS. **과거 답변 라벨은 현재 이름으로 바뀜**: 본문은 “제작 파트너”인데 라벨은 “검토 도우미” | [B로 전환](switch-b-3.png) |
| 40자 이름, 실제 채팅 폭 390px | 헤더 줄임·버튼 배치 PASS. 문서 폭 396px, 입력창 우측 396px → **FAIL** | [390px](long-name-390.png) |
| 같은 이름, 실제 채팅 폭 1280px | 헤더 PASS. 문서 폭 1286px, 입력창 우측 1286px → **FAIL** | [1280px](long-name-1280.png) |
| Studio 설정으로 200% 확대 | 이름·헤더 행동 표시, Tab으로 Clear 이동과 포커스 표시 확인. 모든 행동/스크린리더 통과는 아님 | [200% 확대](long-name-zoom-200.png) |
| 합성 HTTP 400 | 오류를 성공으로 표시하지 않음. 이름·보낸 요청·미전송 후속 입력 보존 PASS | [오류 후](failure-400.png) |
| 응답을 지연시킨 뒤 Stop | 중지 표시, 이름·보낸 요청·미전송 후속 입력 보존 PASS. 자동 재개 검증 아님 | [Stop 후](failure-stall.png) |

HTML 문자가 있는 `<b>제작</b> & "파트너"`는 자식 HTML 없이 텍스트로 렌더됐다.
기존 이름 미설정 수업은 “코치”로 돌아갔고 같은 6px 초과 폭이 관측됐다(폭 679/문서 685).
이름으로 `sdk_tools`, `coach_runtime`, model 설정이 달라지지 않는 Service 비교도 통과했다.

Chalk의 실제 브라우저 검사는 별도로 실행했다: 이름 저장·재열기·고정 버전 확인,
다른 탭의 초안 개명 후 고정 이름 유지, 409/401/403 시 편집 중 이름 보존,
390px 문서 폭·페이지 오류 없음·토큰 브라우저 저장 없음이 통과했다.
재현 스크립트는 [chalk-authoring runner](../../../e2e/chalk-authoring/run.mjs),
로컬 화면은 `e2e/test-results/agent-experience/chalk-feature-a/authoring-mobile.png`다.

## 설계로 되돌려야 할 결정

1. **이름을 바꾸는 UI와 당시 실행의 정체성은 별도 요구사항이다.** 현재 이름 전달만으로 AE-08 전체를 완료하면 과거 책임 소재가 달라진다. 수업/실행별 identity 보존을 다음 단위에서 검증한다.
2. **표시 이름과 실행 모델을 분리한다.** 화면에는 “제작 파트너”가 보여도 이 실행의 Service 로그는 `claude-sonnet-4-6`을 기록했다. 학생이 이름에서 모델·권한을 추측하게 두지 않는다. E7의 실제 모델/실행 상태 표시가 여전히 필요하다.
3. **화면 증거와 학습 증거를 분리한다.** 이름을 잘 전달했다는 것은 준비된 환경의 한 조건을 확인한 것이다. 판단·검토·전이·유지는 사람의 행동 근거로 따로 검증한다.
4. **실패 원인을 수업 언어로 전달한다.** 400 화면은 원문 `Claude Code returned an error result`를 노출한다. 입력은 보존되지만 학생에게 다음 행동을 설명하는 오류 문구는 후속 E1 검수 대상이다.

## 실행의 제한과 재현

[기능 A 인수 문서](../../testing/agent-experience-feature-a.md)에 실행 명령과 남은 조건이 있다.
Worker `test:authoring`은 25/25, Chalk 브라우저 검사는 PASS. 확장·webview 빌드도 PASS.
기존 baseline의 잘못된 SHA/이전 bundle 대조는 앱 실행 전에 각각 실패했다
([음성 대조](baseline-negative-controls.json)); 이 기록의 baseline 검수 SHA는 `6684bd1`이다.

첫 인수 실행은 runner가 수업 시작 버튼을 누르지 않아 중단되어 수정했다. 확대 검사는
Electron zoom만 직접 바꾸던 runner를 Studio 설정 변경·native capture로 고쳤다.
합성 503은 45초 내 종료되지 않아 **503 자동 복구 미검증**으로 남겼으며, 이를 400 성공으로 대체해 주장하지 않는다.
초기 authoring-only SQLite에는 usage 테이블이 없어 실제 모델 실행 fixture에 저장소의 정식 fresh schema를 적용했다.
최종 증거의 400·Stop·확대 결과는 그 수정 이후 실행이다.

NOT RUN: 구버전 앱/새 Service 실기 조합(ADR 표만 검토), 앱 종료 후 재열기, 모든 이름 표면,
스크린리더·Windows UX, Cursor 인증 후 동일 과제 비교, 다중 모델 실행, Browser/Computer Use,
수업 전체 AE-T36, 실제 강사·학습자 리허설. 이 검수는 배포·머지 승인이 아니다.

## 입력창 수정 재검수

수정 `bb6efac52d53a2aec1e16aae9930ff21b608dccf`는 원 후보 위에
`.hps-input textarea { box-sizing: border-box; }`만 추가한다. padding·border가
`width: 100%`에 포함되면서 6px 초과가 사라진다. 판단 기준을 완화하지 않았다.

검수 SHA `939dab82e6fc7472d24fd9f1e94ce2fc64d1c7f1`, run
`e2e/test-results/agent-experience/20260908T155519Z-width-fix`.
별도 앱 사본의 webview만 다시 빌드·주입하고 실제 Studio에서 재검수했다.
Service/SDK/계약 소스는 그대로이므로 이 재검수는 모델을 다시 호출하지 않았다.

| 실제 채팅 폭 | 수정 전 문서 폭 | 수정 후 문서 폭 | 넘친 요소 | 실제 화면 |
|---|---|---|---|---|
| 390px | 396px | 390px | 없음 | [수정 후 390px](width-fix/long-name-390.png) |
| 1280px | 1286px | 1280px | 없음 | [수정 후 1280px](width-fix/long-name-1280.png) |

[200% 확대·Tab 포커스](width-fix/long-name-zoom-200.png)도 다시 열어 확인했다.
현재 이름 전환·HTML 텍스트·기존 수업을 포함한 이 실행의 10개 검사는 통과했다.
[환경](width-fix/environment.json), [결과](width-fix/identity-result.json), [이미지 해시](width-fix/capture.json).
원 후보 SHA로 수정된 제품을 검수하려는 요청도 [실행 전 거부](width-fix/product-negative-control.json)했다.
이것으로 전체 접근성·과거 정체성·학습 효과까지 완료하지 않는다.

협업 관찰: 제품 후보가 오기 전에는 baseline과 인수 조건을 준비했고, 제출 후에는 정확한 SHA를
검수했다. 첫 실행에서 수업 시작·확대 측정·SQLite 범위를 보완하는 왕복이 있었다.
CSS 담당 이전을 기록한 뒤 동일한 수정이 Claude 작업 트리에도 나타났다. 이슈 댓글 전달 지연이
중복 수정의 원인이 될 수 있어 같은 선언을 두 번 합치지 않도록 수정 SHA를 공통으로 인계했다.
다음 단위는 파일 담당 기록을 확인한 뒤 시작한다. 시간 절감·효율 개선 수치는 측정하지 않았다.

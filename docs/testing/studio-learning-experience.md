# 학습 경험 우선 Studio 검증 계약

상태: 검증 계약 제안, 실행 전(NOT RUN). 2026-09-18. Owner: jayleekr.

원문: [UI/UX 설계 철학](../design/ui-philosophy-2026-09-18.md) §12·§16·§17·§18 · 분류: [브레이크다운](../design/ux-principles-breakdown-2026-09-18.md) · 의도: [INT-SX-00~10](../intents/studio-learning-experience.md) · 요구: [SX-01~60](../requirements/studio-learning-experience.md) · 설계: [studio-learning-experience](../design/studio-learning-experience.md) · 계획: [plan](../plan/studio-learning-experience.md) · 형제 계약: [INT-MC](../intents/measurement-core.md).
층과 명령의 정본: [05-testing-requirements](../dev/05-testing-requirements.md). 증거 규칙의 정본: [08-ux-evidence](../dev/08-ux-evidence.md). 판정 규율: [.claude/rules/verification.md](../../.claude/rules/verification.md). 실패 분류 어휘: [docs/plan/dag.yaml](../plan/dag.yaml) `classifications`.

이 문서는 검사를 **정의**한다. 문서에 적힌 검사는 실행된 검사가 아니다. 모든 행은 NOT RUN에서 시작하고, 실행 기록은 별도 evidence 문서(`docs/testing/studio-learning-experience-<날짜>-evidence.md`)에 남긴다. 기존 단위 테스트 통과나 문서 검사 통과를 이 행들의 PASS로 옮기지 않는다.

## 층과 명령

네 층은 05-testing-requirements가 정한다. 여기에 이 계약이 새로 요구하는 다섯째 계측기(렌더 DOM 감사)를 더한다.

| 층 | 무엇을 재는가 | 명령 | 이 계약에서 쓰는 곳 |
|---|---|---|---|
| 단위/스모크 | 순수 헬퍼: 게이트 판정, 이벤트 스키마, 라벨 lint, 상태 기계 전이 | `cd extensions/hypeproof-chat && npm test` (전체) · `node --experimental-strip-types test/<name>.smoke.mjs` (한 파일) | SX-T02·03·14·17·20·21·24·27·31·34·52~57 |
| Electron e2e | 실제 `.app`, 실제 webview, 포커스, CTA 활성/비활성, 경계에서만 열리는 회고 | `cd e2e && npm install && npm test` · `HPS_APP_PATH`로 미출하 확장 검사 · 조용한 실행은 `bash scripts/e2e-quiet.sh` | SX-T01·04·05·06·10~13·15·16·18·22·23·25·26·28·30·32·33·35·36·38·40~45·50·51 |
| Worker | 관측 배치 수신·검증·강사 조회 권한 | `cd worker && npm install && npm test` | SX-T37·39·50·56 |
| 실연(rehearsal) | 살아 있는 Service 계약, 토큰 수명 | `cd tests/rehearsal && npm install && npm test` | SX-T50(강사 조회 경로) |
| 렌더 DOM 감사 (신설) | webview 본문 텍스트에서 금지 문자열·수치의 부재 | `cd e2e && npx playwright test tests/sx-dom-audit.spec.ts` (파일명은 제안. 구현 PR이 확정한다) | SX-T05·T13·T30·T35·T40·T42·T43·T44·T45·T59 |
| Module/Chalk | 세션 설계 파일 저작 계약 | `(cd chalk && npm ci && npm test && npm run typecheck)` | SX-T55·T56 |
| 문서 | 링크·요구 참조·헤더 | `python3 scripts/docs-harness/check.py --min-score 95` | 이 문서 자체 |

### 렌더 DOM 감사 계측기

목적: "작업 중 화면에 점수·등급·배지·금지 라벨이 없다"는 주장을 눈이 아니라 DOM 텍스트로 판정한다.

동작:
1. `e2e/fixtures/app.ts`의 `launchApp`으로 앱을 띄우고 `chatFrame(ctx.win)`(작업 화면)과 `startFrame(ctx.win)`(진입 화면)의 본문 텍스트를 덤프한다. 영역 분리는 설계 문서가 정할 컴포넌트의 루트 선택자로 한다. 현재 코드에서 확인된 루트는 `ChatPanel.tsx`의 `.hps-shell`·`.hps-header`, `NativeObservationPanel.tsx`의 `details.hps-native-observation`, `StartPage.tsx`의 `#start-title`·`#connect-title`뿐이다. Mission header·Coach rail·Work canvas·Evidence drawer·Reflection·Growth 영역의 선택자는 아직 코드에 없다. 구현 후 해당 컴포넌트 파일을 읽고 정한다(verification.md 규칙 1). 이 문서는 그 선택자를 미리 쓰지 않는다.
2. 영역별로 두 목록을 검사한다. (a) 금지 문자열: §12의 라벨 6개, "점수", "등급", "N/7", "7자산", "AI 의존도", "상위", "랭킹". (b) 금지 수치 패턴: `\d+점`, `\d+%`, `\d+/[67]`, "N등급". 허용 수치는 명시적 allowlist로 둔다: `\d+주차`, `남은 단계 \d+`, 날짜·시각, 그리고 SX-51이 허용하는 주차(가격·GTM·지표)에서 Work canvas 안의 숫자.
3. 판정 함수는 순수 함수로 분리한다(`e2e/native-trial-checks.mjs` + `.test.mjs` 패턴을 따른다). 앱 없이 밀리초 단위로 돈다.

자기 검증(verification.md 규칙 2·3, 대조군 없는 채점기는 신뢰하지 않는다):
- 양성 대조군: 정상 작업 화면 텍스트 시료(주차·미션·남은 단계 2·CTA 1개 포함)가 **통과**해야 한다. 너무 엄격한 계측기를 잡는다. 특히 "3주차"와 "남은 단계 2"를 수치로 잡으면 계측기 결함이다.
- 음성 대조군: "검증 점수 62점", "7자산 4/7", "개선 필요", "상위 10%", "AI 활용 고수"를 각각 심은 시료가 **실패**해야 한다. 너무 관대한 계측기를 잡는다.
- 심은 정답: 결함 6종(라벨 6개)을 한 시료에 심고 정확히 6건을 찾는지 센다.
- 대조군이 하나라도 틀리면 그 실행의 모든 감사 결과는 무효다. 제품 판정으로 올리지 않는다.

실패 분류 순서는 dag.yaml과 같다. 계측기(harness_fixable / harness_undecided)를 먼저 배제한 뒤 product를 말한다. 2026-07-25~27 사흘 동안 9건 중 9건이 계측기였다.

## Slice 1 수용 기준 (SX-T01~06)

§17의 여섯 항목을 순서대로 옮겼다. Slice 1 인수는 여섯 행 전부 PASS와 SX-T60의 사람 판정이 함께 있어야 한다.

| ID | 검사 내용 | 통과 조건 | 실패 시 분류 | 층/명령 | 대상 SX |
|---|---|---|---|---|---|
| SX-T01 | 첫 화면 5초 안에 "지금 할 것"을 말할 수 있다. 앱 진입 후 첫 렌더에서 Mission header의 주차·미션 한 문장·완료 조건·남은 단계와 action 1~3개가 보이는지, 그리고 사람 관찰에서 5초 내 응답이 나오는지 | e2e: 첫 렌더 5초 안에 미션 문장과 action이 attached·visible이고 점수·등급 텍스트가 같은 화면에 없다. 사람: SX-T60 프로토콜에서 참가자가 5초 내 "지금 할 것"을 과제 언어로 말한다 | 렌더는 안 됐는데 텍스트 대기가 짧으면 harness_fixable · 화면은 맞는데 사람이 못 말하면 product 또는 spec(문장이 모호) | Electron e2e + 사람 관찰 | SX-01, SX-02, SX-04 |
| SX-T02 | AI 초안 이후 기대 조건을 쓰기 전 "완료" CTA 비활성. 초안 도착 직후 CTA 상태, 기대 조건 입력 뒤 상태, 기대 조건을 지웠을 때 상태 | 초안 후 CTA `disabled` · `criterion_set` 이벤트가 학생 원문과 함께 저장된 뒤에만 활성 · 빈 문자열·공백만은 조건으로 인정하지 않음 · 키보드 Enter로도 우회 불가 | 게이트 함수 단위 테스트 실패는 product · CTA 선택자 미확인이면 harness_fixable | 단위(게이트 순수 함수) + Electron e2e | SX-14, SX-47 |
| SX-T03 | 재확인 없이 검증 완료 없음. 수정 요청 뒤 (a) 재확인 안 함, (b) 다른 조건으로 확인, (c) 같은 조건으로 확인 세 경로 | (a)(b)는 `retest_confirmed`가 생기지 않고 검증 상태가 미완료로 남는다 · (c)만 `retest_confirmed`가 `change_requested`와 같은 criterion id를 참조하며 저장된다 · "같은 조건"의 정의는 criterion id 일치이며 텍스트 유사도가 아니다 | 조건 동일성 판정이 모호하면 spec · 이벤트 누락은 product | 단위(이벤트 연결) + Electron e2e | SX-15, SX-47 |
| SX-T04 | 실제 사용자 반응과 가상 예시가 UI와 데이터 양쪽에서 구분된다. real·simulated 두 시료를 넣고 화면 라벨과 저장 레코드를 함께 본다 | UI: 두 시료의 라벨 문구가 다르고 아이콘+문구가 함께 있다(색만으로 구분하지 않음) · 데이터: `source_state`가 저장 시점 값으로 고정되고 이후 편집에도 바뀌지 않는다 · 라벨 없는 외부 반응 레코드는 저장이 거부된다 | 스키마 검증 누락은 product · 라벨 문구 미정은 spec | 단위(스키마) + Electron e2e | SX-21, SX-46 |
| SX-T05 | 작업 중 역량 점수·등급·개선 필요 배지 없음. 작업 화면(Mission header, Coach rail, Work canvas, 상태바)의 렌더 DOM 텍스트 | 렌더 DOM 감사가 금지 문자열·수치 0건 · VS Code 상태바에 `7자산` 텍스트 항목이 없다(`assetStatusBar.ts` 제거 확인) · 감사의 양성·음성 대조군이 그 실행에서 통과 | 대조군 실패는 harness_fixable · allowlist 다툼은 harness_undecided · 잔존 텍스트는 product | 렌더 DOM 감사 | SX-59, SX-43 |
| SX-T06 | 주차 종료 회고는 "바뀐 생각 1개 + 다음 실험 1개"만. 회고 화면의 입력 필드 수와 제출 조건 | 필수 필드가 정확히 2개 · 그 외 평가·점수·자기 진단 필드 없음 · 두 필드가 채워지면 `reflection_submitted`가 저장되고 다음 실험이 다음 과제에 연결된다(SX-T31) | 필드 개수 초과는 product · "다음 실험"의 저장 위치 미정은 spec | Electron e2e + 단위 | SX-27, SX-28 |

## HOME · COACH (SX-T10~19)

| ID | 검사 내용 | 통과 조건 | 실패 시 분류 | 층/명령 | 대상 SX |
|---|---|---|---|---|---|
| SX-T10 | Mission header 상시 노출. 스크롤·패널 전환·프리뷰 열림·좁은 창(최소 지원 폭)에서 header가 유지되는지 | 네 상태 모두에서 주차·미션·완료 조건·남은 단계 4요소가 visible · 좁은 창에서 잘림 대신 줄바꿈 | 선택자 미확인은 harness_fixable · 가려짐은 product | Electron e2e | SX-01 |
| SX-T11 | 학생 홈 = 오늘의 작업. 상단 한 문장, 중앙 action 1~3개, "지난번 이어서" 유무(이전 세션 있음/없음 두 조건) | action 수가 1 이상 3 이하 · 이전 세션이 있으면 이어가기 진입이 있고 없으면 없다 · 홈에 성장·점수 카드가 없다 | 이전 세션 fixture 준비 실패는 harness_fixable | Electron e2e | SX-02 |
| SX-T12 | 성장 인사이트 진입의 시각 우선순위. 홈에서 미션 CTA와 변화 기록 링크의 크기·위치·스타일 비교 | 변화 기록 진입은 링크 수준(Primary CTA 스타일 아님) · 미션 CTA보다 아래 또는 옆 · 첫 화면에서 자동 열림 없음 | 스타일 비교 기준(크기·클래스) 미정은 harness_undecided | Electron e2e + 스크린샷 | SX-03 |
| SX-T13 | 한 화면 Primary CTA 1개. 홈·작업·회고·변화 기록 네 화면에서 Primary 스타일 요소 수 | 각 화면 정확히 1개 · 화면 전환 후에도 1개 | Primary 판정 클래스는 설계 문서의 토큰 정의를 읽고 정한다. 미정이면 harness_undecided | 렌더 DOM 감사(클래스 계수) | SX-04 |
| SX-T14 | 학습 정보 / 작업 공간 / 근거 기록의 분리. 세 영역이 한 컨테이너에 섞여 렌더되지 않는지 | 세 영역의 루트가 서로 다른 형제 노드 · 근거 drawer는 기본 닫힘 · 작업 중 회고 영역 없음 | 영역 루트 선택자는 구현 후 확정. 미확정이면 harness_fixable | Electron e2e | SX-05 |
| SX-T15 | Coach rail 내용 유형. 코치 응답 N개 시료의 말미 문장 분류(질문·힌트·체크리스트·강사 메시지 vs 답·대안 선택·최종 결정) | 시료의 말미 문장이 답·최종 선택으로 끝난 건수 0 · 분류는 사람이 원문을 읽는다. 정규식으로 의미를 판정하지 않는다 | 원문 판독 없이 자동 분류만 했으면 harness_undecided · 코치가 답을 주면 product(프롬프트) | 저비용 대조 후 실제 모델 + 원문 검토 | SX-06, SX-11 |
| SX-T16 | 작업 중 피드백 게이트. 과제와 무관한 코치 개입(칭찬·요약·평가)이 작업 중 rail에 나타나는지 | 작업 중 rail의 코치 메시지가 전부 "현재 과제 수행"과 연결(질문·힌트·체크리스트) · 평가형 형용사 0건(SX-T19의 lint 재사용) | 게이트 판정 기준이 모호하면 spec | Electron e2e + 원문 검토 | SX-07 |
| SX-T17 | Intervention ladder 순서. 같은 막힘을 반복 제시했을 때 개입이 질문→구조화→힌트→예시→강사→정답 순으로 올라가는지, 건너뜀이 있는지 | 6단계 순서 위반 0 · 5단계(강사 호출)는 판단이 아니라 막힌 맥락을 전달한다 · 6단계(정답)는 예외 사유 필드가 있을 때만 발생하고 사유가 저장된다 | 단계 판정을 사람이 읽지 않았으면 harness_undecided | 단위(단계 상태) + 실제 모델 + 원문 검토 | SX-08, SX-09, SX-10 |
| SX-T18 | 대화 설계 표 5상황 응답 계약. 모호한 문제·초안 완성·가격·반응 없음·회고 각 상황의 시료 입력 | 5상황 모두 §10 "나쁜 UX" 열의 형태(지시·확정·평가)가 아니고 "좋은 UX" 열의 형태(되묻기·비교 제안·관찰 문장)다 · 사람이 원문을 판독 | 프롬프트 계약 위반은 product | 실제 모델 + 원문 검토 | SX-11 |
| SX-T19 | 언어 규칙 lint. 평가형 형용사(우수·부족·낮음·높음), "당신은 ~한 사람", 실제/AI 예시 라벨 미분리, 모델과 학생 행동이 한 문장에 섞임을 코치 응답·회고·변화 기록 카피에서 검사 | Appendix "피한다" 열 5문장이 음성 대조군으로 전부 잡히고 "쓴다" 열 5문장이 양성 대조군으로 전부 통과 · 실제 시료에서 위반 0 | 대조군 실패는 harness_fixable · 새 어휘 다툼은 harness_undecided | 단위(lint 순수 함수) + 원문 검토 | SX-12 |

## WORK · EVID (SX-T20~29)

| ID | 검사 내용 | 통과 조건 | 실패 시 분류 | 층/명령 | 대상 SX |
|---|---|---|---|---|---|
| SX-T20 | Work canvas 중심 배치. 에디터·프리뷰·테스트·데이터가 중앙, 설명·근거는 rail/drawer | 중앙 영역에 설명·근거 텍스트 블록이 없다 · 프리뷰 열림이 canvas를 벗어나지 않는다 · 기존 `09-preview.spec.ts`의 프리뷰 계약 유지 | 배치 기준 미정은 harness_undecided | Electron e2e | SX-13 |
| SX-T21 | 변경 전후 보기. AI 초안 → 학생 수정 → 기준 세 항목이 되짚어지는지 | `artifact_before`·`artifact_after`·해당 criterion이 한 화면에서 열리고 원문이 보존 · 되짚기가 데이터를 바꾸지 않는다 · `AE-05/37`의 기존 검사 통과 | 기존 검사 실패면 그 문서의 분류 | 단위 + Electron e2e | SX-16, SX-17 |
| SX-T22 | Evidence drawer 기본 닫힘·필요 시 열림. 초기 상태, 수동 열기, 이벤트 저장 후 자동 열림 여부 | 초기 닫힘 · 사용자가 열 때만 열림 · 이벤트 저장이 drawer를 강제로 열지 않는다 · 내용은 기대 조건·근거·변경 전후·출처 4종 | 초기 상태 확인 시점이 렌더 전이면 harness_fixable | Electron e2e | SX-17 |
| SX-T23 | evidence type 6종 저장·표시. Intent·Criterion·Action·Decision·Change·Ownership 각각 한 건 | 6종이 스키마 검증을 통과하고 drawer에서 종류가 구분되어 보인다 · 미정의 type은 거부 | 스키마 미정은 spec | 단위(스키마) + Electron e2e | SX-18, SX-44 |
| SX-T24 | KO/EN 혼용 입력. 한 문장 안 KO/EN 혼용, EN 인용 + KO 해석을 한 화면 비교 | 혼용 입력이 거부·변형되지 않고 원문 그대로 저장 · 의미와 근거가 같은 화면 | 언어 감지로 거부하면 product | 단위 + Electron e2e | SX-19 |
| SX-T25 | provenance. 누가·언제·어떤 상황(context)에서 말했는지가 모든 인용에 붙는지 | 인용 카드마다 actor·시각·context 3요소 · 누락 인용은 렌더되지 않고 "출처 없음"으로 표시 | 3요소 중 무엇이 필수인지 미정은 spec | 단위 + Electron e2e | SX-20 |
| SX-T26 | source_state 라벨 고정. real / simulated / self_reported / unverified 4값의 UI 라벨과 데이터 값 대응 | 4값 모두 UI 문구가 다르고 데이터와 1:1 · 저장 후 값 변경 시도가 거부됨 · 라벨 없는 레코드 렌더 시 `unverified`로 표시하며 `real`로 승격하지 않음 | 승격이 일어나면 product | 단위 + Electron e2e | SX-21, SX-46 |
| SX-T27 | 외부 근거 유형 구분. 링크·기사·규정·인터뷰 각각 저장 | 4유형이 구분 저장·표시 · 링크 자체는 근거가 아니라 출처로 분류 | 유형 분류 미정은 spec | 단위 | SX-22 |
| SX-T28 | 선택 이유 한 줄 기본 UX. 추천 뒤 선택 시 이유 입력이 기본 노출·선택적 강제 여부 | 선택 화면에 이유 필드가 기본 노출 · 이유 없이 선택하면 `decision`이 `student_text` 없이 저장되되 "이유 없음"으로 표시 · 강제 설문 아님(NAT-03 유지) | 강제 여부 다툼은 spec | Electron e2e | SX-23 |
| SX-T29 | 팀 프로젝트 기여 구분. AI 기여·학생 판단·학생 수정이 같은 산출물에서 분리 기록 | actor별 기여가 분리되어 저장되고 "기여 분리" 보기에서 확인 · AI 기여가 학생 기여로 합산되지 않음 | 합산이 일어나면 product | 단위 + Electron e2e | SX-24, SX-45 |

## REFL · GROW (SX-T30~39)

| ID | 검사 내용 | 통과 조건 | 실패 시 분류 | 층/명령 | 대상 SX |
|---|---|---|---|---|---|
| SX-T30 | 회고는 경계에서만. 작업 중·제출·세션 종료·주차 종료 네 시점에서 회고 영역 유무 | 작업 중 0 · 나머지 세 경계에서만 열림 · 렌더 DOM 감사로 작업 중 회고 문자열 부재 확인 | 경계 판정 이벤트 미확인은 harness_fixable | Electron e2e + 렌더 DOM 감사 | SX-25 |
| SX-T31 | 다음 실험이 다음 과제에 추가. 회고 제출 후 다음 과제 화면 | 회고의 "다음 실험" 원문이 다음 과제 action 목록에 그대로 나타난다 · 요약·의역 없음 | 연결 저장 위치 미정은 spec | 단위 + Electron e2e | SX-28 |
| SX-T32 | 성공은 배지가 아니라 다음 도전. 과제 완료 직후 화면 | 배지·스트릭·랭킹·축하 모달 없음 · 다음 과제 또는 다음 실험으로의 진입이 첫 요소 | 축하 요소 판정 기준 미정은 harness_undecided | Electron e2e + 렌더 DOM 감사 | SX-29 |
| SX-T33 | 변화 기록 첫 화면 구성. 최근 발견한 변화 1개 + 근거 2~3개, 점수 카드는 접힘 | 첫 화면(접힘 열기 전)에 숫자 없음 · 근거 2 이상 3 이하 · 6개 점수 카드는 `details` 형태로 닫혀 있고 여는 동작 전 텍스트가 DOM에 노출되지 않는다 | 접힘 안 텍스트가 DOM에 있는데 시각적으로만 숨김이면 product | 렌더 DOM 감사 + Electron e2e | SX-30, SX-60 |
| SX-T34 | 한 사건으로 성향을 말하지 않음. 과제 1개에서 반복 없는 시료와 과제 3개 이상에서 같은 기준·같은 평가기로 반복된 시료 | 전자에는 패턴 문장이 생성되지 않고 "아직 충분히 보지 못함" · 후자에만 "최근 반복된 패턴" · 평가기 버전이 다르면 패턴 생성 안 함(MC-45/46) | 반복 임계값 미정은 spec | 단위(생성 조건 순수 함수) | SX-31 |
| SX-T35 | 근거 클릭이 실제 문장으로. 변화 기록의 근거 세션 클릭 | 클릭 후 실제 학생 원문·결정·결과가 열린다 · 연결 없는 해석 문장은 렌더되지 않는다 | 연결 없는 해석이 렌더되면 product | Electron e2e | SX-32 |
| SX-T36 | 근거 없음의 표현. 관찰 0건인 항목 | "0", "0점", "낮음"이 아니라 "아직 충분히 보지 못함" | 문구 다툼은 spec | 렌더 DOM 감사 + 단위 | SX-33 |
| SX-T37 | 변화 기록의 마지막 요소. 화면 하단 | 마지막 블록이 "다음에 실험해볼 것" 1개 · 2개 이상이면 실패 | 블록 순서 선택자는 구현 후 확정 | Electron e2e | SX-34 |
| SX-T38 | 금지 라벨 6개·대체 라벨 5개. 변화 기록·회고·강사 화면·코치 응답 카피 | 금지 6개 0건 · 관찰 없음·패턴·불일치·다음 실험 각 상황에서 대체 라벨 5개 중 하나가 쓰인다 · 음성 대조군 6개가 전부 잡힌다 | 대조군 실패는 harness_fixable | 렌더 DOM 감사 + 단위(lint) | SX-35, SX-36 |
| SX-T39 | 우선순위 2·4·5. "아직 드물게 본 행동" 카드, 근거 타임라인, 방법/세부 접힘 | 세 요소가 §12 순서(2·4·5)로 있고 5번은 기본 접힘 · 2번 문장은 관찰 건수를 "최근 N개 과제 중 M개" 형식의 문장으로만 쓴다(숫자 카드 아님) | 문장 형식 미정은 spec | Electron e2e | SX-37 |

## 부정 테스트 목록 (SX-T40~45)

§18 안티패턴 6개를 순서대로 부정 테스트로 만들었다. 각 행은 "있으면 실패"다. 통과가 곧 안전은 아니다. 계측기의 음성 대조군이 그 실행에서 통과했을 때만 이 행의 PASS를 기록한다.

| ID | 검사 내용 | 통과 조건 | 실패 시 분류 | 층/명령 | 대상 SX |
|---|---|---|---|---|---|
| SX-T40 | 모든 화면에 6개 역량 점수. 홈·작업·회고·변화 기록 첫 화면·강사 화면에서 여섯 역량 이름(Framing·Judgment·Orchestrate·Verify·Adapt·Ownership 및 한글 표기)과 점수 | 작업 흐름 화면에서 역량 이름+수치 조합 0건 · 변화 기록에서는 접힘 안에서만 | 잔존은 product · 역량 이름 목록 불일치는 harness_fixable | 렌더 DOM 감사 | SX-43, SX-59, SX-60 |
| SX-T41 | AI가 다음 답을 추천. 코치가 "이렇게 하세요"·"이 답이 맞습니다" 형태로 선택을 대신하는지 | 코치 응답에 추천 확정문 0 · 대안 비교 틀(선택지 2개 이상 + 기준)로 대신 · AI 추천이 `decision` 이벤트의 actor=student로 저장된 건 0 | 프롬프트는 product · actor 저장은 product | 실제 모델 + 원문 검토 + 단위 | SX-06, SX-45 |
| SX-T42 | "개선 필요" 배지 남발. 모든 화면 | "개선 필요" 0건 · 현재 작업 상태와 다음 실험으로만 표현 | 잔존은 product | 렌더 DOM 감사 | SX-35 |
| SX-T43 | 가상 데이터를 실적처럼 표시. simulated 시료를 metric·반응·매출 위치에 넣기 | simulated가 real과 같은 스타일·같은 집계에 들어가지 않음 · 가짜 결제가 매출로 합산되지 않음 · 라벨 없는 시료는 unverified 표시 | 합산은 product | 단위 + Electron e2e + 렌더 DOM 감사 | SX-21, SX-46, SX-58 |
| SX-T44 | 모든 행동을 수치화. 클릭수·토큰수·체류시간·메시지수를 화면이나 판단 입력으로 쓰는지 | 학생·강사 화면에 이 4종 수치 0건 · 관측 레코드에 저장되더라도 능력 해석의 입력으로 쓰이지 않음(HC-06/07 유지) | 화면 잔존은 product | 렌더 DOM 감사 + 단위 | SX-39, SX-43 |
| SX-T45 | 회고를 매 세션 팝업으로. 연속 3세션 시작·종료 | 세션 시작 시 회고 모달 0 · 세션 종료 시에도 모달이 아니라 inline 영역 · 회고 미작성이 다음 세션 진입을 막지 않음 | 모달 판정 선택자는 구현 후 확정 | Electron e2e | SX-26, SX-52 |

부정 테스트의 문자열 목록(계측기와 요구 문서가 같은 목록을 본다. 정본은 요구 문서 SX-35·SX-59):
- 금지 라벨: 개선 필요 · 낮음/높음 · 상위 N% · 역량 부족 · AI 활용 고수 · 성장 점수
- 작업 화면 수치: `\d+점`, `\d+%`, `\d+/7`, `\d+/6`, 등급
- 상태바: `7자산` 텍스트(`extensions/hypeproof-chat/src/assetStatusBar.ts`가 만드는 `7자산 N/7` 항목. `test/asset-status.smoke.mjs`는 이 텍스트의 존재를 검사하므로 SX-59 구현과 함께 제거 또는 반전한다)
- 세션마다 뜨는 회고 모달
- 라벨 없는 simulated 데이터

## INST · DATA · DS · CURR · LEGACY (SX-T50~59)

| ID | 검사 내용 | 통과 조건 | 실패 시 분류 | 층/명령 | 대상 SX |
|---|---|---|---|---|---|
| SX-T50 | 강사 화면 표시 항목과 금지 항목, 개입 CTA. 학생 2명(막힘 있음/없음) 시료로 강사 화면을 연다 | 표시: 진행 상태·학생 원문·막힌 지점·확인할 증거·실제/가상 여부 5종 · 금지: 점수 순위·채팅량/토큰량/체류시간·AI 의존도·성격/잠재력·코호트 랭킹 0건 · CTA는 질문 보내기 / 다시 보게 할 지점 표시 / 근거 확인·추가 관찰 필요 3종만이고 "답변하기"·"평가 완료"는 없다 · 강사 인증은 기존 `role: "issuer"` + `IssuerScope`(`worker/src/lib/instructor-auth.ts`)를 쓰고 새 역할을 만들지 않는다. 학습 근거 조회 경로와 학생 공유 범위 선택(MC-39)이 없으면 BLOCKED로 기록 | 조회 경로·공유 경로 부재는 BLOCKED(P4 전) · 금지 항목 잔존은 product | Electron e2e + Worker(조회 권한) + 렌더 DOM 감사 | SX-38, SX-39, SX-40 |
| SX-T51 | 기관 정책 가드레일. 학생이 실제 인터뷰·결제·외부 링크를 다루는 시나리오 3개 | 각 시나리오에서 정책 확인 단계가 학생 판단을 대신하지 않고 강사 매개 경로로 연결 · 정책 미설정이면 해당 행동이 "미확인"으로 남고 real로 저장되지 않음 | 정책 내용 미정은 spec | Electron e2e | SX-41 |
| SX-T52 | teacher_state 분리. unreviewed / confirmed / disputed 전이와 자동 판단의 독립 | 자동 판단이 teacher_state를 바꾸지 않음 · 강사만 confirmed/disputed 전이 · disputed 항목이 변화 기록의 패턴 입력에서 제외 | 전이 규칙 미정은 spec | 단위(상태 전이) + Worker | SX-42 |
| SX-T53 | 필드 7개 스키마. actor·context·evidence_type·source_state·student_text·artifact_before/after·teacher_state | 7필드 스키마 검증이 있고 각 필드 누락 시료가 거부 · actor에 AI 추천이 student로 들어가는 시료가 거부 · 기존 `hps-observation/1`(`nativeObservationContract.ts`)의 `validateObservation` 확장으로 구현되었고 제2 검증기가 아님 | 제2 검증기를 만들면 product(SX-48 위반) | 단위 | SX-44, SX-45, SX-48 |
| SX-T54 | 이벤트 8종. problem_committed·criterion_set·test_observed·change_requested·retest_confirmed·external_feedback_received·decision_revised·reflection_submitted 각 1건 | 8종 모두 스키마 통과, 미정의 종류 거부 · `external_feedback_received`는 source_state 없이는 거부 · `retest_confirmed`는 선행 `change_requested` 없이는 거부 | 선후 관계 미정은 spec | 단위 | SX-47, SX-46 |
| SX-T55 | 디자인 토큰 역할·상태 표현·숫자 카드·모달·학생 문장 우선. 토큰 6개가 설계 문서 값과 일치하는지, 상태가 아이콘+문구인지, 학습 화면 숫자 카드 수, 모달 사용처, 학생 원문의 시각 우선 | 토큰 값은 설계 문서에서 읽어 비교(이 문서는 값을 갖지 않는다) · 상태 요소마다 텍스트 노드 존재 · 학습 화면 숫자 카드 0, 가격·GTM·지표 주차에서만 허용 · 모달은 파괴적 확인 외 0 · 학생 원문 블록이 AI 설명 블록보다 먼저·크게 | 토큰 값 다툼은 harness_undecided · 잔존은 product | 렌더 DOM 감사 + Electron e2e + 스크린샷 | SX-49, SX-50, SX-51, SX-52, SX-53 |
| SX-T56 | 작업 화면 대비와 회고 Paper. 작업 화면·회고 화면 스크린샷 | 작업 화면 배경이 Deep forest 계열이고 작업물 영역이 가장 밝다 · 회고·보고서는 Paper 배경 · 값 비교는 설계 문서 토큰 기준 | 색 판정 기준 미정은 harness_undecided | 스크린샷 + 렌더 DOM 감사 | SX-54 |
| SX-T57 | 과제 흐름 상태 기계. 과제→실행→제출→회고→다음 과제 전이와 "다음으로"의 의미 | 정방향 전이만 허용, 회고 건너뛴 "다음 과제" 전이 거부 · 각 상태에서 "다음으로" 버튼의 목적지가 상태 기계와 일치 · 되돌리기는 데이터 보존 | 전이 표 미정은 spec | 단위(상태 전이) + Electron e2e | SX-55 |
| SX-T58 | 세션 설계 파일에서 읽기. 주차·미션·완료 조건·핵심 UI·관찰 항목이 코드가 아니라 Module 파일에서 오는지 | 시료 Module 파일 두 벌(주차 문구가 다른)로 앱을 띄우면 Mission header가 각 파일 내용을 보인다 · 코드 grep에서 6주 주차 문구 하드코딩 0건 · `chalk/` 저작 계약 테스트 통과 | 하드코딩은 product · 저작 계약 미정은 spec | Module/Chalk + Electron e2e | SX-56 |
| SX-T59 | 관측을 위한 함정 금지, 주차별 "절대 하지 않을 것" 6개. 각 주차 시료에서 AI 인터뷰 대필·문제 자동 선택·추상 문구 선생성·고의 오류·가짜 결제 실적·SNS 클릭 PMF·예측 확정 표현 | 7항목 각각 0건 · 코치 프롬프트에 함정·유도 지시가 없음(프롬프트 파일 원문 검토) · 가짜 결제 시료가 매출 위치에 오지 않음(SX-T43 재사용) | 프롬프트는 product · 판정 기준 미정은 harness_undecided | 원문 검토 + 실제 모델 + 단위 | SX-57, SX-58 |

LEGACY 두 요구는 위 행에 포함된다. SX-59(작업 중 점수 없음, `assetStatusBar.ts` 제거)는 SX-T05·T40이, SX-60(/measurement 점수 카드를 접힌 세부로)은 SX-T33·T40이 검사한다. SX-60의 화면 자체는 Lab 웹(`hypeprooflab` `/measurement`)에 있으므로 이 저장소의 e2e가 아니라 Lab 쪽 검사가 실행 주체다. 여기서는 Studio가 내보내는 데이터에 점수를 첫 화면 필드로 두지 않는지만 본다. 기존 hps-six-auto 리포트 보존은 파일 존재와 스키마 불변으로 확인한다.

## 검증 (SX-T60)

| ID | 검사 내용 | 통과 조건 | 실패 시 분류 | 층/명령 | 대상 SX |
|---|---|---|---|---|---|
| SX-T60 | 5초 회상 테스트와 Jay dogfood 인수 | 아래 두 프로토콜 모두 충족 | 사람 판정. 자동 분류하지 않는다 | 사람 관찰 + 설치된 앱 | SX-01, SX-02, SX-14, SX-15, SX-25, SX-27 (§16) |

5초 회상 테스트 프로토콜:
1. 대상: 과제 하나를 끝까지 돈 참가자(첫 버전은 Jay). 학생 파일럿은 보호자 동의·강사 매개 경로 이후이며 이 프로토콜의 범위 밖이다.
2. 시점: 과제 완료 다음 날 또는 다음 세션 시작 전. 앱을 열기 전에 묻는다.
3. 질문: "지난번에 무엇이 기억나나요?" 한 문장만. 추가 유도 없음.
4. 기록: 처음 5초 안에 나온 첫 문장을 원문 그대로 적는다. 분류는 두 갈래다. (a) 실제 문제·사용자 반응·자기가 바꾼 행동 (b) 점수·라벨·역량 이름·등급.
5. 판정: (a)가 먼저 나오면 통과. (b)가 먼저 나오면 실패이며 정보 우선순위 결함으로 기록한다. 답을 못 하면 실패가 아니라 "관찰 불가"로 남기고 재시도한다.
6. 관찰자와 참가자가 같은 사람이면(Jay 혼자) 녹음 또는 즉시 타이핑으로 첫 문장을 남긴다. 사후 회상으로 채우지 않는다.

Jay dogfood 인수 프로토콜:
1. 환경: 설치된 `.app`(개발 서버가 아니라 릴리스 후보 패키지)과 세션 설계 파일 하나로 만든 과제 하나. 앱 버전·Module revision·날짜를 먼저 적는다.
2. 경로: 진입 → Mission header 확인 → 코치와 작업 → AI 초안 → 기대 조건 작성 전 완료 시도(막혀야 함) → 기대 조건 작성 → 테스트 → 차이 발견 → 수정 요청 → 다른 조건으로 재확인(검증 완료가 되지 않아야 함) → 같은 조건으로 재확인 → 제출 → 회고(필드 2개) → 다음 과제에 실험이 붙음.
3. 증거: 각 단계 스크린샷(캡처 명령 명시), 저장된 이벤트 8종 중 이 경로에서 생겨야 하는 것의 레코드, 렌더 DOM 감사 결과, 대조군 결과.
4. 판정: 게이트 두 개(완료·재확인)가 실제로 막았고, 작업 중 화면에 수치가 없었고, 회고가 경계에서만 열렸고, 5초 회상 테스트를 통과했을 때 인수. 하나라도 빠지면 부분 인수가 아니라 미인수다.
5. 자동 재생(Playwright가 같은 경로를 도는 것)은 SX-T01~59의 증거다. Jay의 인수를 대신하지 않는다.

## 실기 증거 규칙

08-ux-evidence의 기준(시나리오 이름·코호트/프로필·앱 버전·날짜·캡처 명령·알려진 한계)을 따르고, 여기에 출처 라벨을 더한다.

| 라벨 | 뜻 | 허용되는 용도 |
|---|---|---|
| live-host | 설치된 앱과 살아 있는 Service·모델에서 사람이 조작해 얻은 증거 | SX-T60 인수, SX-T15·T17·T18·T41의 원문 검토 |
| captured-replay | 실제 실행에서 캡처한 응답·이벤트를 재생해 얻은 증거 | e2e 회귀, 렌더 DOM 감사의 반복 실행 |
| synthetic | 만들어 넣은 시료(합성 페르소나, 심은 결함, 가짜 이벤트) | 단위 테스트, 대조군, 스키마 검증 |

규칙:
- 모든 증거 파일 이름 또는 첫 줄에 라벨 하나를 적는다. 라벨 없는 증거는 synthetic으로 취급한다.
- synthetic·captured-replay는 절대 Jay의 인수 증거가 아니다. SX-T60은 live-host만 인정한다.
- 앱 버전(`package.json` version과 빌드 hash), Module revision, 날짜, 캡처 명령(예: Playwright `page.screenshot` 호출이 있는 spec 경로, 또는 macOS 화면 캡처 명령)을 증거 문서 상단에 적는다.
- 실제 참가자 정보·토큰·모델 키는 증거에 넣지 않는다. `nativeObservationRecorder.ts`의 자격증명 제거가 그대로 적용된다.
- 모델 원문은 합성 실험의 허용 범위만 기록한다. 학생 원문은 파일럿 전까지 Jay 본인 것만 있다.
- 스크린샷은 실제 인터페이스 상태를 그대로 담는다. 잘라낸 분위기 이미지는 증거가 아니다.
- 실패 기록에는 분류(harness_fixable / harness_undecided / product / spec / flake)와 그 근거를 같이 적는다. 분류 없는 FAIL은 미분류로 남기고 제품 결함으로 보고하지 않는다.

## 커버리지

| SX 묶음 | 요구 ID | 검사 행 |
|---|---|---|
| HOME | SX-01 | T01, T10 |
| HOME | SX-02 | T01, T11, T60 |
| HOME | SX-03 | T12 |
| HOME | SX-04 | T01, T13 |
| HOME | SX-05 | T14 |
| COACH | SX-06 | T15, T41 |
| COACH | SX-07 | T16 |
| COACH | SX-08 | T17 |
| COACH | SX-09 | T17 |
| COACH | SX-10 | T17 |
| COACH | SX-11 | T15, T18 |
| COACH | SX-12 | T19 |
| WORK | SX-13 | T20 |
| WORK | SX-14 | T02, T60 |
| WORK | SX-15 | T03, T60 |
| WORK | SX-16 | T21 |
| EVID | SX-17 | T21, T22 |
| EVID | SX-18 | T23 |
| EVID | SX-19 | T24 |
| EVID | SX-20 | T25 |
| EVID | SX-21 | T04, T26, T43 |
| EVID | SX-22 | T27 |
| EVID | SX-23 | T28 |
| EVID | SX-24 | T29 |
| REFL | SX-25 | T30, T60 |
| REFL | SX-26 | T45 |
| REFL | SX-27 | T06, T60 |
| REFL | SX-28 | T06, T31 |
| REFL | SX-29 | T32 |
| GROW | SX-30 | T33 |
| GROW | SX-31 | T34 |
| GROW | SX-32 | T35 |
| GROW | SX-33 | T36 |
| GROW | SX-34 | T37 |
| GROW | SX-35 | T38, T42 |
| GROW | SX-36 | T38 |
| GROW | SX-37 | T39 |
| INST | SX-38 | T50 |
| INST | SX-39 | T44, T50 |
| INST | SX-40 | T50 |
| INST | SX-41 | T51 |
| INST | SX-42 | T52 |
| DATA | SX-43 | T05, T40, T44 |
| DATA | SX-44 | T23, T53 |
| DATA | SX-45 | T29, T41, T53 |
| DATA | SX-46 | T04, T26, T43, T54 |
| DATA | SX-47 | T02, T03, T54 |
| DATA | SX-48 | T53 |
| DS | SX-49 | T55 |
| DS | SX-50 | T55 |
| DS | SX-51 | T55 |
| DS | SX-52 | T45, T55 |
| DS | SX-53 | T55 |
| DS | SX-54 | T56 |
| CURR | SX-55 | T57 |
| CURR | SX-56 | T58 |
| CURR | SX-57 | T59 |
| CURR | SX-58 | T43, T59 |
| LEGACY | SX-59 | T05, T40 |
| LEGACY | SX-60 | T33, T40 |

60개 요구 전부에 검사 행이 하나 이상 있다. 미커버 0.

## 실행 상태

문서 발행 시점의 상태다. 실행 기록은 evidence 문서에서만 갱신하고 이 표는 행 전체 인수 상태만 옮긴다. 부분 PASS를 여기에 쓰지 않는다.

| ID | 상태 | ID | 상태 | ID | 상태 |
|---|---|---|---|---|---|
| SX-T01 | NOT RUN | SX-T20 | NOT RUN | SX-T40 | NOT RUN |
| SX-T02 | NOT RUN | SX-T21 | NOT RUN | SX-T41 | NOT RUN |
| SX-T03 | NOT RUN | SX-T22 | NOT RUN | SX-T42 | NOT RUN |
| SX-T04 | NOT RUN | SX-T23 | NOT RUN | SX-T43 | NOT RUN |
| SX-T05 | NOT RUN | SX-T24 | NOT RUN | SX-T44 | NOT RUN |
| SX-T06 | NOT RUN | SX-T25 | NOT RUN | SX-T45 | NOT RUN |
| SX-T10 | NOT RUN | SX-T26 | NOT RUN | SX-T50 | NOT RUN |
| SX-T11 | NOT RUN | SX-T27 | NOT RUN | SX-T51 | NOT RUN |
| SX-T12 | NOT RUN | SX-T28 | NOT RUN | SX-T52 | NOT RUN |
| SX-T13 | NOT RUN | SX-T29 | NOT RUN | SX-T53 | NOT RUN |
| SX-T14 | NOT RUN | SX-T30 | NOT RUN | SX-T54 | NOT RUN |
| SX-T15 | NOT RUN | SX-T31 | NOT RUN | SX-T55 | NOT RUN |
| SX-T16 | NOT RUN | SX-T32 | NOT RUN | SX-T56 | NOT RUN |
| SX-T17 | NOT RUN | SX-T33 | NOT RUN | SX-T57 | NOT RUN |
| SX-T18 | NOT RUN | SX-T34 | NOT RUN | SX-T58 | NOT RUN |
| SX-T19 | NOT RUN | SX-T35 | NOT RUN | SX-T59 | NOT RUN |
| | | SX-T36 | NOT RUN | SX-T60 | NOT RUN |
| | | SX-T37 | NOT RUN | | |
| | | SX-T38 | NOT RUN | | |
| | | SX-T39 | NOT RUN | | |

SX-T50은 학습 근거의 강사 조회 경로와 학생 공유 범위 선택이 생기기 전(P4)에는 실행하면 BLOCKED다. 강사 인증 자체는 이미 있다(`role: "issuer"`, `IssuerScope`). NOT RUN과 BLOCKED를 구분해 적는다. 기능이 미구현인 행은 NOT RUN, 실행에 필요한 환경·권한이 없는 행은 BLOCKED와 원인이다.

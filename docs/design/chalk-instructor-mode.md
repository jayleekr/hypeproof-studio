# Chalk 강사 모드 · 구독 연결 · 기록 적재 · 디자인 기준 설계

- 상태: 설계 (chalk-engineer 초안, 2026-09-24)
- 이슈: #1296 (상위 #1283)
- 요구: SUB-01~11 · UX-04 · UX-05 · RH-02 · GEN-06
- 입력: T0 확인(2026-09-24), [E2-1 설계](chalk-generator-and-tools.md)

---

## 0. T0 에서 확인한 사실 (이 설계의 전제)

| # | 사실 | 출처 |
|---|---|---|
| F1 | 구독 실행(`localRuntime`)은 세 조건이 모두 맞아야 켜진다: 앱 이름 `HypeProof Studio Dev` · `HPS_DEV_RUNTIME=1` · 서버 주소가 `http://localhost` 계열(아니면 오류). 셋 다 PR #1041 에서 왔다 | T0-c, `localRuntime/index.ts:18-30` |
| F2 | 구독 경로에서 앱 기록(spool)에 **남는 것**: 질문(`recordPrompt`), 응답(`recordResponse`). **안 남는 것**: 모델 이름·사용량(`recordUsage` 미호출), 도구 호출·결과(관측 기록에만 감) | T0-a `[코드 추적]` |
| F3 | `claudeClient` 는 턴이 끝나면 `{model, usage}` 를 돌려준다. 지금은 메모리(`sdkTurnTotal`)에만 둔다 | T0-a, `claudeClient.mjs:105` |
| F4 | 로컬 서버는 Cloudflare 로그인 없이 돈다. 서버 모델 호출은 `ANTHROPIC_PROXY_URL` 을 로컬 가짜 서버로 돌리면 키 없이 `completed` 가 된다 | T0-b · T0-e |
| F5 | 기존 `/v1/chat/completions`·`/v1/profile` 은 issuer 토큰을 `wrong_role` 로 막는다 | 재사용 평가 5항 |

---

## 1. 강사 모드 (SUB-08)

### 1-1. 언제 켜지나

- 강사 모드 = **서버가 확인한 강사**일 때만. 앱 쪽 `canAuthor()`(서명 검증 없는 해석)는 버튼을 보일지 정하는 데만 쓰고, 강사 모드를 여는 결정은 서버 확인 뒤에 한다
- 서버 확인: issuer 토큰으로 `GET /admin/chalk/whoami` (새 경로, issuer 전용, 인증은 `instructor-auth.ts` 의 `authorizeIssuer` 만 쓴다). 200 이면 강사 모드를 열 수 있다. 학생 토큰은 401/403 이다
- 🔴 학생 토큰(`TOKEN_KEY` 에 학생 코드만 있음)으로는 강사 모드 UI·Chalk 도구·구독 연결이 **하나도** 열리지 않는다

### 1-2. 무엇이 달라지나

| | 학생 모드 (지금) | 강사 모드 (새로) |
|---|---|---|
| 채팅 화면 | ChatPanel | **같은 ChatPanel**. 머리에 "강사 모드 · 연결 · 모델" 띠 |
| 지시문 | 코호트 프로필 코치 지시문(서버) | 강사 지시문. **서버가 준다**(`GET /admin/chalk/instructor-brief`). 앱에 지시문 원문을 두지 않는다 |
| 도구 | 코호트가 허용한 워크스페이스 도구 | Chalk 도구(E2-1 §1) + 작업 사본 폴더(`chalk/<course>/`) 안의 `Read`·`Edit`·`Write` |
| 모델 | 서버 정책 | 연결에 따라(3절) |

- 강사 모드와 학생 모드는 한 창에서 동시에 켜지지 않는다. 전환은 명시적(Chalk 면에서 "강사 채팅 열기")이고 전환할 때 대화를 새로 시작한다
- 구현 위치: `webview-ui` 에 모드 분기 줄 + 강사 모드 전용 컴포넌트는 새 파일. `chatPanelProvider.ts` 에는 분기 줄만(plan §4-1 R2)

---

## 2. 구독 연결 (SUB-01 · 02 · 04)

### 2-1. 켜짐 조건을 바꾼다 (E4-6)

| 지금 (F1) | 바뀐 뒤 |
|---|---|
| 앱 이름이 Dev 일 것 | **강사 모드일 것**(1-1, 서버 확인) |
| `HPS_DEV_RUNTIME=1` | 강사가 설정에서 "내 구독으로 돌리기"를 켰을 것(기본 꺼짐) + CLI 가 설치·로그인돼 있을 것 |
| 서버 주소가 localhost | **강사 모드에서는 원격 서버 허용.** 학생 모드에서는 구독 실행 자체가 없다 |

- Dev 앱의 개발용 경로(`HPS_DEV_RUNTIME`)는 **그대로 둔다.** 학생 경로를 로컬에서 시험하는 개발 도구이고, 강사 구독과 별개다. 두 경로가 같은 `runLocalCoach` 를 쓰되 켜는 문이 둘이다
- 🔴 **리허설 좌석 예외**: 강사가 학생 조건으로 들어가 구독으로 리허설할 때는 `TOKEN_KEY` 에 학생(리허설) 토큰이 앉아 있다. 이때는 "원래 강사 자격이 `context.secrets` 에 보관돼 있고(RH-04) 지금 토큰이 리허설 좌석(`rehearsal` 클레임)"일 때만 구독 실행을 연다. 세부는 E6-1(#1300)이 정한다
- 부정 대조(필수 시험): 학생 토큰만 있을 때 구독 실행 함수가 호출되지 않는다 · 설정을 켜도 학생 모드에서는 무시된다 · 리허설 토큰이 있어도 보관된 강사 자격이 없으면 열리지 않는다

### 2-2. 자격

- 구독 자격(CLI 로그인)은 강사 컴퓨터에만 있다. 앱은 CLI 를 띄울 뿐 자격을 읽지 않는다. 서버로 보내는 기록(3절)에 자격·토큰·키가 들어가지 않는다(SUB-04)

---

## 3. 모델 고르기 (SUB-09 · 10 · 11)

| 연결 | 목록 출처 | 직접 입력 |
|---|---|---|
| 내 Claude 구독 | 앱에 둔 별칭 목록(`sonnet`·`opus`·`haiku`) | `--model` 에 그대로 넘긴다. CLI 가 모르는 모델이면 첫 턴 오류 → 오류 표시 + 이전 모델로 되돌림 |
| 내 Codex 구독 | Codex `model/list` 응답 | 같은 방식 |
| 서버 | 서버가 허용한 목록(서버 AI 강사용 경로가 돌려줌) | 목록 밖이면 서버가 거부 → 오류 + 이전 모델 |

- UI: 기존 `<select>`(`ChatPanel.tsx:731`)는 그대로 두고 **옆에 입력 칸을 더한다.** 강사 모드에서는 `<select>` 목록 출처를 연결별로 바꾼다(학생 모드는 지금처럼 `model_selection.choices`). 두 입구는 같은 설정 한 칸을 바꾼다. 구현 E4-3(#1298)
- `/model` 슬래시 명령은 만들지 않는다
- 채팅창 위 띠에 늘 보인다: `연결: 내 Claude 구독 · 모델: sonnet`
- 턴마다 쓴 모델을 기록에 남긴다(4절 `model`). 구독이 돌려준 실제 모델 이름(F3)을 우선하고, 없으면 요청한 이름

---

## 4. 구독 경로 기록 적재 (RH-02 · GEN-06 · SUB-11, E4-7 ⛓)

F2 대로 지금 spool 에는 모델·도구 호출이 없다. **새로 잡아서 서버에 올린다.**

### 4-1. 잡는 곳

- 턴 끝(`runLocalCoach` 결과): `{model, usage}` (F3)
- 도구 활동(`onActivity`): 도구 이름 · 입력 요약(원문 대신 해시와 길이) · 결과 상태
- 질문·응답 본문: 지금 spool 이 잡는 것과 같은 자리

### 4-2. 올리는 곳

- `POST /admin/chalk/transcripts` (issuer 전용, 새 경로). 한 번에 턴 한 개
- 본문: `{ turn_id, course_id?, rehearsal_id?, mode: 'design'|'rehearsal', connection: 'claude-sub'|'codex-sub', model, usage?, user_text, assistant_text, tools: [{name, input_sha256, input_len, status}], at }`
- 서버는 받은 기록에 **"앱이 올린 기록"** 표시를 붙여 저장한다. 서버가 직접 본 요청 기록(스택의 `authoring_rehearsal_turns`)과 구별된다. 결정 8 (나)로 이 기록도 확정 근거가 된다(E6-6)
- 올리기 실패 시: 앱이 로컬에 쌓아 두었다가 다시 보낸다(spool 과 같은 폴더의 대기열). 강사 모드를 끌 때 남은 것이 있으면 알린다
- 🔴 학생 모드 대화는 이 경로로 올리지 않는다(학생 기록은 기존 서버 경로가 남긴다)

### 4-3. 저장

- 테이블은 E4-7 에서 만든다(번호는 리드 배정, `0030`~). `schema.sql` 도 함께 고친다(T0-e: 로컬은 `schema.sql` 로 초기화한다)

---

## 5. 서버 AI 강사용 경로 (SUB-03 · GEN-06, E4-8)

구독이 없거나 꺼져 있으면 서버(조직 키)로 돈다. **같은 채팅, 같은 도구**다.

- `POST /admin/chalk/assist` (issuer 전용, 새 경로). 기존 `/v1/chat/completions` 의 `wrong_role` 은 풀지 않는다(F5)
- 흐름: 앱이 대화와 **도구 정의**를 보낸다 → 서버가 강사 지시문을 붙여 모델을 부른다 → 모델이 도구 호출을 내면 서버는 **실행하지 않고 앱에 돌려준다** → 앱의 Chalk 도구 층이 실행하고 결과를 다음 요청에 담는다. 도구 구현은 앱 한 곳뿐이다(SUB-07)
- 비용(MVP — 새 테이블 없이): `persistUsage` 에서 `cohort_id` = 강의 코호트, `user_id` = `issuer:<토큰 u>` 접두사, `session_id` = null. `captureUsageCost` 는 그대로 부른다. `budget-admission` 은 부르지 않는다(학생 예산·이용권에서 빼지 않는다)
- ⚠️ `usage_log.user_id` 칸 제약과 기존 집계가 `issuer:` 접두사 값을 받는지는 E4-8(A-02)이 구현할 때 확인한다. 미충족 시 별도 저장 방법을 다시 정한다(→ 열린 질문 Q5)
- 모델: 서버가 허용한 목록만. 서버가 별칭을 푼다
- 시험: 로컬은 `ANTHROPIC_PROXY_URL` → 가짜 모델 서버(F4). 실모델은 J4(선택)가 생기면

---

## 6. 디자인 기준 (UX-04 · UX-05)

| 새 화면 | 기준 화면 | 기준 파일 |
|---|---|---|
| 강사 채팅 | 학생 코치 대화 패널 | `extensions/hypeproof-chat/webview-ui/src/ChatPanel.tsx`, `webview-ui/src/styles.css` |
| Chalk 시작·강의 목록 | Studio 시작 화면 | `extensions/hypeproof-chat/src/startPage.ts` |
| Chalk 사이드바 | 기존 사이드바 목록(TreeView) | VS Code 기본 TreeView (`feat/1184` 의 `chalkSurface.ts` 방식) |
| 계획서 보기 | 내장 브라우저 | Studio 내장 브라우저 |
| 검사 결과 표시 | 편집기 문제 표시 | VS Code `DiagnosticCollection` (코드 오류 밑줄과 같은 모양) |

- 색·글꼴·간격은 **기존 CSS 변수(`--vscode-*` 와 `styles.css` 의 토큰)만** 쓴다. 새 색 값(hex·rgb)을 컴포넌트 코드에 직접 쓰지 않는다
- 의미 있는 고정 색(강사 모드 띠, 경고 등)이 필요하면 `styles.css` 에 **이름 붙은 CSS 변수로 한 번만** 정의하고 그 변수를 쓴다(예: `--hps-instructor-accent`). 값은 가능하면 `--vscode-*` 변수를 가리킨다(예: `var(--vscode-editorWarning-foreground)`)
- citation chip 의 직접 색 값은 기존 선례일 뿐 따라 하지 않는다. 고치지도 않는다(범위 밖)
- 새 부품이 필요하면 먼저 위 기준 파일에서 비슷한 것을 찾는다. 없을 때만 만들고 PR 에 이유를 적는다
- 검수: 👁 PR 은 머지 전에 JY 가 dev 앱에서 직접 본다(`jy-dev-review.md`). PR 본문 `JY dev 검수:` 줄에 비교 기준 화면을 적는다

---

## 7. SUB 요구 ↔ 부품

| 요구 | 부품 | 이슈 |
|---|---|---|
| SUB-01 · 02 · 04 | §2 구독 연결 켜짐 조건 · 자격 | E4-6 |
| SUB-03 | §5 서버 AI 강사용 경로 | E4-8 |
| SUB-05 | 리허설 경로 차이 경고 | E6-5 |
| SUB-06 · 07 | Chalk 도구 층(E2-1) | E4-2 |
| SUB-08 | §1 강사 모드 | E4-3 |
| SUB-09 · 10 · 11 | §3 모델 고르기 · 기록 | E4-3 · E4-7 |

---

## 8. 열린 질문

| # | 질문 | 리드 기본값 |
|---|---|---|
| Q1 | `whoami` 확인을 앱이 켤 때마다 할까, 토큰 저장 때 한 번 할까 | 강사 모드를 열 때마다. 토큰 폐기가 바로 반영되게 |
| Q2 | 구독 기록에 질문·응답 본문 전체를 올릴까 | 올린다(강사 본인 작업, FB-05 재료). 크기 상한 턴당 64KB, 넘으면 자르고 표시 |
| Q3 | 서버 AI 경로를 스트리밍으로 할까 | 첫 판은 비스트리밍. 체감이 나쁘면 후속 |
| Q4 | Claude 구독 모델 별칭 목록을 앱에 둘까 서버에서 받을까 | 앱에 둔다(구독은 서버와 무관). CLI 가 거부하면 오류로 알린다 |
| Q5 | `usage_log.user_id` 칸 제약·집계가 `issuer:` 접두사를 받는가 | E4-8(A-02) 구현 시 확인. 안 되면 저장 방법 재정 |

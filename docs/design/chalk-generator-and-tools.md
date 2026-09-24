# Chalk 생성기 · 검사 고리 · Chalk 도구 계약 설계

- 상태: 설계 (chalk-engineer 초안, 2026-09-24)
- 이슈: #1292 (상위 #1281)
- 요구: GEN-01~06 · FB-01~05 · SUB-06 · SUB-07
- 전제: [E1-1 설계](chalk-knowledge-and-plan-spec.md) — 지식 저장, 계획서 규격 `chalk-plan/1`, 초안 저장(`chalk_plan_files` + `content.plan_ref`), 검사 결과 위치 모양

---

## 0. 한 장 그림

```
 강사 ─ 말 ─▶ 강사 채팅 (ChatPanel 강사 모드)
               │
               ▼
          구독 AI (claude / codex CLI, 강사 컴퓨터)     ← 생성·편집·설명은 여기서 돈다
               │  도구 호출 (MCP / dynamicTools)
               ▼
 버튼 ─────▶ Chalk 도구 층 (확장, 한 벌)                ← 도구 = 서버 API 한 번 + 입력 검증
               │  HTTPS, issuer 토큰
               ▼
          Studio 서버 (worker/)                          ← 저장 · 모형 추천 · 검사 · 지식 · 기록
```

- **생성은 모델이, 판정은 서버가.** 모델은 계획서 문장을 쓰고 고친다. 무엇이 규격 위반인지, 어떤 모형이 맞는지, 어떤 검사가 걸리는지는 서버가 정한다
- **도구는 한 벌이다**(SUB-07). 버튼도 같은 도구 함수를 부른다. 서버 AI 경로(SUB-03, E4-8)도 모델이 낸 도구 호출을 **앱의 같은 도구 층이 실행**한다(서버가 도구를 따로 구현하지 않는다)

---

## 1. Chalk 도구 목록 (SUB-06)

도구 이름은 `chalk_` 로 시작한다. 입력은 JSON 스키마로 고정하고 `additionalProperties: false`. 모든 도구는 강사 모드에서만 AI 에 붙는다.

| 도구 | 입력 | 부르는 서버 API | 돌려주는 것 | 이슈 |
|---|---|---|---|---|
| `chalk_list_courses` | — | `GET /admin/chalk/courses` | 강사의 강의 목록(초안·확정) | E4-5 (A-02) |
| `chalk_open_course` | `course` | `GET …/authoring/:course` | 초안(revision · 입력 · 계획서 파일 경로) | 기존 API |
| `chalk_set_inputs` | `course`, `audience`, `assets[]`(7개 중), `teaching_style`, `requirements`, `format`(`workshop`/`track`) | `PUT /admin/chalk/courses/:course/inputs` (입력은 `chalk_plan_files` 옆 입력 기록에. `content` 에 넣지 않는다) | 새 revision | E2-6 |
| `chalk_recommend_methods` | `course` | `POST /admin/chalk/courses/:course/recommend` | 후보·제외 모형과 근거, 쓴 지식 버전 | E2-2 |
| `chalk_generator_brief` | `course`, `file`(`lesson`/`ops`) | `GET /admin/chalk/courses/:course/brief?file=` | 생성 지침 묶음(아래 2절) | E2-6 |
| `chalk_get_knowledge` | `kind`, `doc_id?` | `GET /admin/chalk/knowledge/:version/docs…` | 지식 문서(초안의 지식 버전으로 고정) | E1-2 |
| `chalk_save_plan` | `course`, `file`, `expected_revision` | `PUT /admin/chalk/courses/:course/plan` (계획서 원문은 `chalk_plan_files`, 초안 `content` 에는 `plan_ref` 만. 두 쓰기를 한 batch 로) | 새 revision + **자동 검사 결과** | E2-6 |
| `chalk_check_plan` | `course` | `POST /admin/chalk/courses/:course/check` | 검사 결과(3절 모양) | E2-3 |
| `chalk_judge_items` | `course`, `items[]` | `GET …/judge-brief` → 모델 판정 → `POST …/judgements` | 문맥 판정 결과 저장 | E2-5 (A-02) |
| `chalk_record_feedback` | `course`, `text` | `POST /admin/chalk/courses/:course/feedback` | 기록 ID | E2-7 (A-02) |
| `chalk_diff` | `course`, `from_revision`, `to_revision?` | `GET …/diff` | 바뀐 절·단계 목록 | E2-7 (A-02) |
| 리허설 · 확정 · 내보내기 도구 | — | E6 · E5 설계가 정한다 | — | E5 · E6 |

- 🔴 **계획서 편집은 파일로 한다.** 계획서 HTML 은 강사 작업 폴더에 작업 사본(`<course>/지도안.html` 등)으로 열린다(UX-03 "편집기로 원문을 열어 고칠 수 있다"). 모델은 기존 `Read`·`Edit` 도구로 이 파일을 고치고, `chalk_save_plan` 이 파일 내용을 서버 초안에 올린다. 강사가 편집기에서 직접 고쳐도 같은 버튼(=같은 도구)으로 올린다. **서버 초안이 원본이고, 파일은 작업 사본이다**
- `chalk_save_plan` 은 저장이 성공하면 **같은 응답에 검사 결과를 싣는다.** 모델이 따로 검사를 부르지 않아도 고칠 때마다 검사가 돈다(FB-02)
- revision 이 어긋나면(다른 곳에서 저장) 도구는 저장하지 않고 "다시 열기"를 돌려준다. 조용히 덮어쓰지 않는다(OUT-04)

---

## 2. 생성 흐름 (GEN-01 · 03 · 04 · 05)

### 2-1. 생성 지침 묶음 `chalk_generator_brief`

서버가 한 번에 돌려주는 것. 모델은 이것만 보고 쓴다. **서버가 조립하므로 지침이 앱이나 프롬프트에 복사되지 않는다.**

```json
{
  "knowledge_version": 3,
  "inputs": { "audience": "...", "assets": ["intent","verify","iterate","ownership"], "teaching_style": "...", "requirements": "...", "format": "workshop" },
  "methods": { "chosen": ["m-002","m-007"], "excluded": [{"id":"m-005","because":["short-session","novice-learners"]}] },
  "authoring_order": ["evidence","objectives","essential-question","prohibited-moves","flow","key-questions","support","…"],
  "time_spec": { "format": "workshop", "core": ["intro","explore","first-try","improve","share"], "total_min": 240 },
  "skeleton_html": "<html data-chalk-plan=\"1\" …>…빈 절과 표식…</html>",
  "rules": [ {"item":"G2-9","says":"…"}, … ],
  "family_session": true
}
```

- `authoring_order` 는 지식 `guide:authoring-order` 에서 온다(GEN-03: 증거 → 성취기준 → 본질적 질문 → 금지 개입 → 활동)
- `skeleton_html` 은 규격 `chalk-plan/1` 의 빈 뼈대다. 절·표식이 이미 박혀 있고 모델은 내용만 채운다. 표식을 모델이 지어내지 않게 하는 장치다
- `methods` 는 `chalk_recommend_methods` 결과 그대로다. 모델은 모형을 바꾸지 않는다. 강사가 다른 모형을 원하면 입력을 바꾸거나 강사가 직접 고른다(서버가 어휘로 다시 검사)

### 2-2. 순서

```
1. chalk_set_inputs          입력 다섯 가지 (빠지면 모델이 강사에게 묻는다)
2. chalk_recommend_methods   서버가 어휘로 고른다 → 모델이 근거를 강사에게 설명
3. chalk_generator_brief     지침 묶음
4. 작업 사본에 뼈대를 쓰고 authoring_order 대로 절을 채운다 (Write/Edit)
5. chalk_save_plan           저장 + 자동 검사
6. 검사 결과를 읽고 고친다 → 5 로. 최대 3바퀴, 그 뒤에는 남은 결과를 강사에게 보인다
7. 강사 피드백 → 편집 → 5 로 (FB-01)
```

- 6 의 "최대 3바퀴"는 모델이 검사 통과만 좇아 계획서를 망가뜨리지 않게 하는 상한이다. 남은 경고는 강사가 판단한다. 초안 검사는 막지 않는다(FB-03)
- 13절은 생성기가 새로 쓸 때 채운다. 기존 문서를 가져올 때는 비워 둔다(결정 2)

### 2-3. 기록 (GEN-05 · GEN-06 · FB-05)

- 초안 `content.plan_ref.knowledge_version` 과 `chalk_plan_files.knowledge_version` 에 쓴 지식 버전을 남긴다. 같은 버전 + 같은 입력이면 같은 지침 묶음이 나온다(모델 출력까지 같다는 뜻은 아니다)
- 도구가 부르는 서버 API 는 서버가 **도구 호출 기록**을 남긴다(누가 · 어느 강의 · 어느 도구 · revision · 쓴 모델 이름(앱이 헤더로 보냄) · 시각). 구독 경로라도 도구를 거친 일은 서버에 남는다
- 도구를 거치지 않은 대화 본문(모델의 말, 강사의 말)은 E4-7(구독 대화 적재, A-02 ⛓)이 올린다

---

## 3. 검사 고리 (FB-02 · 03 · 04)

### 3-1. 결과 모양

E1-1 §2-7 모양에 두 칸을 더한다.

```json
{ "item": "G2-9", "check": "duration_consistency", "severity": "warn", "judge": "machine",
  "at": { "file": "lesson", "section": "flow", "step": "s-2", "field": null },
  "message": "시간 합이 회차 길이와 12분 어긋난다",
  "remedy": "각 step의 duration 합을 회차 길이에 맞춘다",
  "skipped": false,
  "source": "checkLessonPedagogy",
  "blocks_confirm": false }
```

- `item`: `G*-*` 항목 ID. `check`: 기존 `PedagogyFinding.check` 필드 그대로 (`check` → `item` 매핑은 E2-4 담당)
- `remedy` · `skipped` · `source`: 기존 `PedagogyFinding` 필드 그대로 유지
- `severity`: `fail` · `warn` · `info`. `info`는 신규 수준 — 기존 `checkLessonPedagogy()`는 미발행; `blockingPedagogyFindings()`는 `fail`만 확인(현행 유지). `judge`: `machine` · `model` · `human`
- 🔴 `blocks_confirm`: **지금 서버에 있는 관문 v0 의 `fail` 규칙과 OUT-02 만 `true`.** 새로 더하는 기계 판정 항목(E2-4)과 문맥 판정(E2-5)은 **항상 `false`** 다. 강의 퀄리티 게이트는 후속이다(PRD 7판 10절)
- 초안 단계에서는 `blocks_confirm` 과 상관없이 아무것도 막지 않는다(FB-03)

### 3-2. 무엇이 도나

| 층 | 무엇 | 언제 |
|---|---|---|
| 규격 | E1-4 파서의 규격 위반(13절 없음, 부모 칸 없음 등) | 저장할 때마다 |
| 관문 v0 | 기존 `checkLessonPedagogy()` (계획서에서 파생된 `steps` 로) | 저장할 때마다 |
| 기계 판정 확장 | E2-4 가 더하는 항목(읽기 계약 §4 "기계 가능": G1-*, G2-5~9, G2-11, G3-1, G3-4) | 저장할 때마다 |
| 문맥 판정 | E2-5 (G2-2 · G2-3 · G3-2 등 "LLM 판정") | 강사나 모델이 `chalk_judge_items` 를 부를 때 |
| 사람만 | G2-12 · G3-6 | 도구가 판정하지 않는다. 결과에 `judge: human` 으로 "사람 확인 필요"만 표시 |

- 🔴 G3-6("처음 받은 강사가 추가 설명 없이 실행할 수 있다")은 모델에게 넘기지 않는다(읽기 계약 §4)

### 3-3. 문맥 판정 (FB-04, E2-5 가 구현)

- 판정 지시문은 **서버 코드가 버전과 함께 소유한다**(예: `judge:G2-2@3`). 지식 문서가 아니다 — 제품이 만든 판정 도구이기 때문이다
- 흐름: 도구가 서버에서 `judge-brief`(지시문 ID·버전·원문 + 판정할 계획서 조각)를 받는다 → 강사가 연결한 모델(구독 또는 서버)이 판정한다 → 도구가 결과를 서버에 올린다. 서버는 결과에 `{model, prompt_id, prompt_version, revision, at}` 를 붙여 저장한다
- 예: "아이가 만든 게임 속 점수"는 아동 점수화(B-2)가 아니다 · 힌트가 정답을 담고 있으면 금지 개입이다

---

## 4. 도구 층 구현 경계 (SUB-07, E4-2)

- 위치: `extensions/hypeproof-chat/src/chalk/` 새 폴더. 도구 정의(이름·설명·스키마)와 실행 함수가 한 파일에 있다
- 붙이는 곳: `localRuntime` 의 도구 통로(Claude: MCP 서버, Codex: dynamicTools)와 버튼 명령. 셋 다 **같은 실행 함수**를 부른다
- 실행 함수는 **서버 호출 + 입력 검증 + 작업 사본 파일 읽기/쓰기**만 한다. 판단 로직(어떤 모형, 무엇이 위반)을 두지 않는다
- 인증은 저장된 issuer 토큰. 토큰은 서버로만 가고 모델에게 보이지 않는다
- 학생 모드(학생 토큰)에서는 도구 정의 자체를 AI 에 넘기지 않는다

---

## 5. 서버 쪽 새 경로 요약

| 경로 | 이슈 | 비고 |
|---|---|---|
| `POST /admin/chalk/courses/:course/recommend` | E2-2 | 결정적 함수 |
| `GET /admin/chalk/courses/:course/brief` | E2-6 | 지침 묶음 조립 |
| `POST /admin/chalk/courses/:course/check` | E2-3 | 규격 + v0 + 확장 |
| `GET …/judge-brief` · `POST …/judgements` | E2-5 | 판정 기록 테이블 필요(마이그레이션, 번호는 리드 배정) |
| `POST …/feedback` · `GET …/diff` | E2-7 | 🔴 `authoring_drafts` 는 최신 revision 만 갖는다. 비교(FB-01)와 이력(FB-05)을 위해 **초안 revision 이력 테이블**이 필요하다(E2-7 설계에서 정함) |

- 전부 `worker/src/routes/chalk-*.ts` 새 파일, issuer 전용, 소유 강사만(기존 `owns()` 규칙 재사용). `authoring.ts` 는 고치지 않는다(plan §4-1 R1). `authoring.ts` 의 `owns()` 에 `export` 한 단어만 붙여 재사용한다. 로직을 복사하지 않는다(R1 예외, 한 단어 변경).
- 🔴 issuer Bearer 는 허용 목록(`isIssuerAllowedEndpoint`)에 있는 admin 경로에서만 통한다(T0-b 실측: 목록에 없는 경로는 Basic 인증을 요구한다). 새 `/admin/chalk/*` 경로를 이 목록에 더하는 것을 각 구현 이슈의 작업에 넣는다. 허용 목록은 `worker/src/lib/instructor-auth.ts:59` 한 곳이고 Chalk 웹 포워더와 공유한다(`admin.ts:112`). 두 번째 목록을 만들지 않는다(ARC-01 `instructor-auth-drift` 시험)

---

## 6. 열린 질문

| # | 질문 | 리드 기본값 |
|---|---|---|
| Q1 | 작업 사본 파일 위치 | 강사 작업 폴더 아래 `chalk/<course_id>/`. 열 때마다 서버 초안으로 덮어쓰기 전에 로컬 변경이 있으면 묻는다 |
| Q2 | 생성 루프 상한 | 3바퀴 |
| Q3 | 모형을 강사가 직접 바꾸는 입구 | 입력 수정으로만(서버 재추천). 강사 직접 선택은 후속 |
| Q4 | 도구 호출 기록 테이블을 E2-3 에서 만들까 E4-7 에서 만들까 | E2-3 에서 최소형(도구 이름·강의·revision·모델·시각). E4-7 이 대화 본문을 더한다 |

# Chalk 제품 지식 저장 · 계획서 HTML 규격 · 초안 저장 설계

- 상태: 설계 (chalk-engineer 초안, 2026-09-24)
- 이슈: #1287 (상위 #1280)
- 요구: `docs/requirements/chalk-mvp.md` KB-01 · KB-03 · KB-05 · HTML-01~04 · GEN-04 · SCH-01~03, PRD 결정 1 · 2 · 3 · 9
- 이 문서를 따르는 구현: #1288(지식 저장소) · #1289(가져오기·어휘 검사) · #1290(계획서 파서) · #1291(저장 형식 칸), 그리고 E2 생성기·검사

---

## 0. 지키는 경계

1. **쓰기와 판정은 서버에서 한다**(ARC-01). 앱은 표시와 도구 호출만 한다
2. **실행 중에 볼트를 읽지 않는다**(KB-01). 볼트는 한 번 가져오는 출발 자료다
3. **위치로 참조하지 않는다.** 절·항목·어휘는 모두 안정 키로 가리킨다. 번호(1절, 관문2-2)는 표시일 뿐이다. 볼트가 겪은 위치 참조 사고(인수인계서 §3-2)를 제품에서 되풀이하지 않는다
4. **옛 것은 그대로 읽힌다.** 새 칸은 전부 선택 칸이다. 확정본은 바이트 그대로다(VER-01)

---

## 1. 제품 지식 저장 (KB-01 · 03 · 05)

### 1-1. 모양

한 **버전**은 제품 지식 전체의 스냅숏이다. 버전 안에 **문서**가 여럿 있다. 문서 모양은 Sediment 와 같이 **필드 + 본문**이다(KB-05).

```sql
-- 번호는 리드가 배정한다(0030~). 아래는 모양만.
CREATE TABLE chalk_knowledge_versions (
  version        INTEGER PRIMARY KEY,      -- 1, 2, 3 … 한 번 쓰면 바꾸지 않는다
  parent_version INTEGER,                  -- 어느 버전에서 파생됐나. 첫 가져오기는 NULL
  origin         TEXT NOT NULL,            -- 'vault-import' | 'product-edit'
  source_repo    TEXT,                     -- vault-import 일 때: 'hypeproof_kids_edu'
  source_commit  TEXT,                     -- vault-import 일 때: 가져온 커밋 SHA (KB-02)
  note           TEXT NOT NULL,            -- 왜 이 버전이 생겼나 한 줄
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  doc_count      INTEGER NOT NULL,
  digest         TEXT NOT NULL             -- 문서 전체 sha256. 같은 내용이면 같은 값
);
CREATE TABLE chalk_knowledge_docs (
  version     INTEGER NOT NULL REFERENCES chalk_knowledge_versions(version),
  doc_id      TEXT NOT NULL,               -- 안정 키. 예: 'method:m-001', 'gate:G2-2', 'vocab:goal'
  kind        TEXT NOT NULL,               -- 아래 1-2 표
  fields_json TEXT NOT NULL,               -- 기계가 읽는 필드 (프론트매터에 해당)
  body        TEXT NOT NULL DEFAULT '',    -- 사람용 본문 (마크다운)
  source_path TEXT,                        -- 볼트 안 상대 경로. product-edit 면 NULL
  PRIMARY KEY (version, doc_id)
);
```

- **버전은 통째 스냅숏이다.** 새 버전을 만들 때 바뀌지 않은 문서도 새 버전 번호로 다시 적는다(copy-on-write). 그래야 "버전 N 으로 초안을 다시 만든다"(GEN-05)가 다른 버전을 기웃거리지 않는다. 문서 수가 수백 개 규모라 저장 비용은 문제가 되지 않는다
- **덮어쓰기 없음.** `INSERT` 만 있고 `UPDATE`·`DELETE` 경로는 만들지 않는다
- 다듬기(피드백으로 지식을 고치는 것)는 이번에 **기록까지만** 한다(PRD 7절). `origin='product-edit'` 는 자리만 둔다. 쓰는 API 는 이번에 만들지 않는다
- **마이그레이션 PR 은 `schema.sql` 을 함께 고친다.** 새 테이블은 마이그레이션 SQL 파일과 `schema.sql` 양쪽에 들어가야 한다

### 1-2. 문서 종류

| kind | doc_id 예 | 볼트 출처 | fields 에 담는 것 |
|---|---|---|---|
| `method` | `method:m-001` | `methods/m-*.md` 중 `family` ≠ `reference` | `id` · `family` · `evidence_grade` · `prior_knowledge` · `requires_guidance` · `best_for[]` · `weak_for[]` · `avoid_when[]` |
| `vocab` | `vocab:goal` · `vocab:condition` · `vocab:prior` | `rules/curriculum-schema.md` §method | `keys: [{key, label}]` — 목표 29 · 조건 9 · 선행지식 3 |
| `gate` | `gate:G2-2` | `design/lesson-plan-quality-checklist.md` | `id` · `gate`(1~3) · `judge`(`machine`/`model`/`human`/`unassigned`, 읽기 계약 §4 명시 항목만 machine·model·human; 표 밖은 `unassigned`) · `reads[]`(읽는 칸) |
| `constitution` | `constitution:A-2` | `rules/edu-constitution.md` | 조항 ID · 적용 대상 층 |
| `prohibited-move` | `move:P1` | `rules/prohibited-moves.md` | 계열(P1~P4) · 표시 문구 |
| `placement` | `placement:<id>` | `rules/placement-rules.md` (🔴 C-2a 제외) | 규칙 ID · 조건 |
| `axis` | `axis:<key>` | `rules/measurement-axes.md` | 5축 키 |
| `acceptance` | `acceptance:A1` | `design/activity-acceptance-checklist.md` | A1~A4 |
| `guide` | `guide:authoring-order` · `guide:plan-spec` · `guide:conversion` · `guide:session-format` · `guide:workshop-core` | 작성 가이드 · 지도안 규격 · 변환 규칙 · 회차 형식 · 5블록 코어 | 생성기 지침으로 쓰는 구조화 조각(작성 순서 배열, 절 목록, 시간 규격) |

- 🔴 `method` 는 **`family` 로 거른다.** `kr-*` 의 ID 가 `m-kr-*` 라 ID·파일 이름으로 거르면 근거 등급 D 지도가 섞인다(읽기 계약 §3-3)
- 조사 문서 10건은 가져오지 않는다(근거 등급이 없다, PRD 7절)

### 1-3. 닫힌 어휘 검사 (KB-04)

- 검사기는 `worker/src/lib/` 의 순수 함수 하나다. 가져오기 스크립트(#1289)와 서버 쓰기 경로가 **같은 함수**를 쓴다
- 기준은 **같은 버전 안의** `vocab:*` 문서다. 버전 N 의 `method` 는 버전 N 의 어휘로만 검사한다
- 어휘 밖 값이 하나라도 있으면 **그 버전 전체를 저장하지 않는다.** 부분 저장은 없다
- 볼트 스키마의 lint 13~17 이 볼트에서 아직 안 돈다(인수인계서 §7-11 "지키는 장치가 없다"). 제품 쪽 검사가 그 빈자리를 제품 안에서 막는다

### 1-4. 넣는 길과 읽는 길

| | 어떻게 | 누가 |
|---|---|---|
| 가져오기 | `scripts/chalk-knowledge-import` 가 볼트 경로 + 커밋을 받아 **SQL 파일**을 낸다(버전 행 + 문서 행). 어휘 검사를 통과해야 파일이 나온다 | 사람이 실행 |
| 로컬 적재 | `wrangler d1 execute <db> --local --file=<그 SQL>` | 에이전트 가능 |
| 운영 적재 | 같은 SQL 을 운영 D1 에 | **J3 — JY 답 필요.** 이번 계획은 하지 않는다 |
| 읽기 | `GET /admin/chalk/knowledge/versions` · `GET /admin/chalk/knowledge/:version/docs?kind=` · `GET /admin/chalk/knowledge/:version/docs/:doc_id` | issuer 토큰만. 학생 토큰은 403 |

- 쓰기 API 를 만들지 않는 이유: 이번 범위에 제품 안 다듬기가 없고, 가져오기는 드물고 사람이 확인해야 하는 일이다. 쓰기 API 는 다듬기를 만들 때(후속) 붙인다
- 라우트는 `worker/src/routes/chalk-knowledge.ts` 새 파일에 두고 `admin.ts` 에 한 줄로 붙인다(plan §4-1 R1)

---

## 2. 계획서 HTML 규격 `chalk-plan/1` (HTML-01~04 · GEN-04 · 결정 2 · 9)

### 2-1. 파일

| 파일 | `data-chalk-kind` | 원본인가 | 요구 |
|---|---|---|---|
| 지도안 | `lesson` | 원본 | 13절. 검사·단계 목록·리허설 점검표가 여기서 나온다 |
| 운영 계획안 | `ops` | 원본 | 시간표·행위자·준비물·위험 등(PLAN) |
| 진행자 런북 | `runbook` | **파생** (`ops` 에서 뽑음) | PLAN-10 |
| 참가자 안내문 | `handout` | **파생** (`ops` 에서 뽑음) | PLAN-10 |

- 파생 파일은 `data-chalk-derived-from="<원본 sha256>"` 를 갖는다. 원본이 바뀌면 파생이 낡았음을 알 수 있다
- 한 파일로 완결된다: CSS 는 `<style>` 안에만, **`<script>` 없음, 외부 리소스(폰트·이미지 URL·CDN) 없음**(HTML-03). 이미지가 필요하면 `data:` URI
- 밝은 바탕 한 가지, 다크모드 없음, 본문 폭 하나, 글자 크기 계층(HTML-04). 기본 스타일시트는 생성기가 매번 같은 것을 넣는다(`guide:plan-spec` 에 둔다)

### 2-2. 문서 머리

```html
<html lang="ko" data-chalk-plan="1" data-chalk-kind="lesson">
<head>
  <meta name="chalk:course" content="<course_id>">
  <meta name="chalk:knowledge-version" content="3">           <!-- GEN-05 -->
  <meta name="chalk:format" content="workshop">               <!-- workshop | track (GEN-01, PLAN-01) -->
  <meta name="chalk:audience-tier" content="lv1">             <!-- lv1 | lv2 | adult -->
  <meta name="chalk:family-session" content="true">           <!-- 결정 9: 부모 칸 필수 여부 -->
  <meta name="chalk:duration-min" content="240">
  <meta name="chalk:methods" content="m-002 m-007">           <!-- 고른 모형 -->
```

### 2-3. 지도안 절 — 안정 키

볼트 지도안 규격 12절에서 출발하고, 13절을 더한다(결정 2). **절은 키로 가리키고, 번호는 화면 표시다.**

| 표시 번호 | `data-chalk-section` | 필수 | 기계 표식 |
|---|---|---|---|
| 1 | `meta` | 필수 | 머리 `<meta>` 와 같은 값의 표 |
| 2 | `objectives` | 필수 | 항목마다 `<li data-chalk-objective="obj-1">` |
| 3 | `essential-question` | 필수 | 한 개(`data-chalk-question`) |
| 4 | `evidence` | 필수 | 항목마다 `<li data-chalk-evidence="ev-1">` — 제3자가 볼 수 있는 물건 |
| 5 | `flow` | 필수 | 아래 2-4 흐름 표 |
| 6 | `key-questions` | 필수 | `<li data-chalk-key-question>` |
| 7 | `prohibited-moves` | 필수 | `<li data-chalk-move="P1" data-chalk-step="s-2">` — 계열 P1~P4 각각 최소 1개 |
| 8 | `dev-variants` | 선택 | `<li data-chalk-tier="lv1">` |
| 9 | `home-link` | 가족 수업이면 필수 | |
| 10 | `materials` | 필수 | 운영 계획안 준비물과 연결(`data-chalk-material-ref`) |
| 11 | `safety` | 필수 | `data-chalk-safety="none|attention|protocol"` |
| 12 | `bridging` | 필수 | |
| 13 | `support` | **필수**(결정 2) | 아래 2-5 |

### 2-4. 흐름 표 (5절) — 단계와 행위자 칸

```html
<table data-chalk-flow>
  <tr data-chalk-step="s-2" data-duration-min="40"
      data-chalk-requires="act-011" data-chalk-forbids="">
    <th data-chalk-field="title">규칙 정하기</th>
    <td data-chalk-role="teacher">…</td>
    <td data-chalk-role="assistant">…</td>      <!-- 선택 (결정 9) -->
    <td data-chalk-role="learner">…</td>
    <td data-chalk-role="parent" data-chalk-parent-role="인터뷰어">…</td>  <!-- 가족 수업이면 필수 (결정 9) -->
  </tr>
```

- 단계 ID(`s-*`)는 **초안 안에서 안정**하다. 단계를 끼워 넣어도 기존 ID 는 바뀌지 않는다. 13절·금지 개입·검사 결과 위치가 이 ID 로 단계를 가리킨다
- `data-duration-min` 합이 `chalk:duration-min` 과 ±10분(G2-9). 계산은 서버 검사가 한다
- 행위자 칸 규칙: `teacher` · `learner` 필수. `family-session=true` 면 `parent` 필수이고 `data-chalk-parent-role`(역할 이름, PLAN-04)도 필수. `assistant` 는 선택
- 🔴 `teacher` · `assistant` 칸은 **학생에게 가지 않는다.** 학생 힌트는 13절 `min-support` 에서만 나온다(E5 변환 규칙이 지킨다)

### 2-5. 13절 「단계별 막힘과 지원」

```html
<section data-chalk-section="support">
  <div data-chalk-stuck="st-1" data-chalk-step="s-2">
    <p data-chalk-field="expected-stuck">규칙을 못 정한다</p>        <!-- 리허설 학생 입력의 씨앗 -->
    <p data-chalk-field="signal">5분 넘게 카드가 비어 있다</p>       <!-- 개입 신호 -->
    <p data-chalk-field="min-support">지금 게임에서 제일 쉬운 부분이 어디였어?</p>  <!-- 학생 힌트의 유일한 출처 -->
    <p data-chalk-field="expected-response">정답을 주지 않고 되묻는다</p>  <!-- 리허설 기대 반응 -->
  </div>
```

- 막힘 하나 = 단계 하나에 딸린 네 칸. 한 단계에 여러 개 가능
- 생성기가 새로 쓸 때 채운다. 기존 문서를 가져올 때는 비워 둔다(결정 2)
- 이 절이 리허설 점검표(RH-03)와 학생 힌트(OUT-01)의 원본이다

### 2-6. 운영 계획안 (`ops`) 표식 — 요약

| 칸 | 표식 | 요구 |
|---|---|---|
| 시간표 블록 | `<tr data-chalk-block="b-3" data-start="14:30" data-duration-min="40" data-chalk-step-ref="s-2">` + `data-chalk-field` = `activity`·`asset`·`artifact`·`exit-criteria`·`if-stuck` | PLAN-03 · PLAN-09 |
| 행위자별 행동 | 블록 안 `data-chalk-role` = `facilitator`·`assistant`·`learner`·`parent` | PLAN-04 |
| 완충 | `data-chalk-block-kind="buffer"` + `data-chalk-field` = `if-ahead`·`if-behind` | PLAN-06 |
| 준비물 | `<li data-chalk-material data-kind="physical|digital|account" data-owner="instructor|learner|parent" data-auto="true?">` | PLAN-05 |
| 위험 | `<li data-chalk-risk="ai-latency|content-guard|pace-gap|parent-overreach|overtime" data-chalk-field="first-line">` | PLAN-07 |
| 안내·동의 · 수업 후 제공물 | `data-chalk-section="consent"` · `"post-deliverables"` | PLAN-08 |

- 운영 계획안 블록은 `data-chalk-step-ref` 로 지도안 단계와 이어진다. 둘이 어긋나면(단계 없는 블록, 블록 없는 단계) 검사가 알린다
- 세부 칸 목록은 E3(#1282) 설계에서 확정한다. 이 문서는 표식 방식만 못 박는다

### 2-7. 검사 결과의 위치

파서(#1290)와 검사(#1294)는 위반 위치를 다음 모양으로 낸다. 편집기 문제 표시(E4-4)와 채팅이 같은 모양을 쓴다.

```json
{ "item": "G2-9", "severity": "warn",
  "at": { "file": "lesson", "section": "flow", "step": "s-2", "field": null },
  "message": "시간 합이 회차 길이와 12분 어긋난다" }
```

- `at` 은 키만 쓴다. 줄 번호·문자 위치는 앱이 HTML 을 열 때 표식을 찾아 계산한다(서버는 줄 번호를 모른다)

---

## 3. 초안 저장 (결정 3 · OUT-04)

### 3-1. 🔴 계획서 원문은 `content` 에 넣지 않는다

초안 1 은 `content.plan.files` 에 계획서 HTML 을 넣자고 했다. **틀렸다.** 코드를 확인하니(`chat-gate.ts:300-320`, `learning-prompt.ts:66-80`) 코치 지시문에 `JSON.stringify(coachVisibleLesson(content))` 가 **그대로** 들어간다. 확정본 `content` 는 학생 앱에도 전달된다(`chat.ts:283`). `content` 에 계획서를 넣으면:

- 교사 칸 · 금지 개입 · 성취기준 · 평가 증거 등 **강사만 봐야 할 것이 코치 프롬프트와 학생 기기로 샌다**(볼트 변환 규칙 §2 의 금지 목록 전체)
- 계획서 수십 KB 가 **매 턴 코치 프롬프트에 실린다**

그래서 계획서 원문은 **별도 테이블**에 두고, `content` 에는 **가리키는 값만** 둔다.

```sql
-- 번호는 리드가 배정(0030~). schema.sql 도 함께 고친다.
CREATE TABLE chalk_plan_files (
  cohort_id   TEXT NOT NULL,
  course_id   TEXT NOT NULL,
  ref_kind    TEXT NOT NULL,        -- 'draft' | 'version'
  ref         TEXT NOT NULL,        -- draft 면 revision(문자열), version 이면 'm2026.09.24-1'
  file        TEXT NOT NULL,        -- 'lesson' | 'ops' | 'runbook' | 'handout'
  html        TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  knowledge_version INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (cohort_id, course_id, ref_kind, ref, file)
);
```

```ts
// SessionDesign 선택 칸 — 원문이 아니라 참조만. 코치·학생에게 가도 해가 없는 값.
plan_ref?: {
  spec: 'chalk-plan/1';
  knowledge_version: number;          // GEN-05
  files: { lesson: string; ops?: string };   // 각 파일의 sha256
  methods: string[];                  // 고른 모형 ID
};
```

- **초안 저장**: 도구가 계획서 파일을 `chalk_plan_files`(`ref_kind='draft'`, `ref=<새 revision>`)에 쓰고, 같은 요청에서 `authoring_drafts` 를 `SAVE-01` CAS 로 올린다. 새 경로(`PUT /admin/chalk/courses/:course/plan`)가 두 쓰기를 한 트랜잭션(D1 batch)으로 묶는다. revision 이 어긋나면 둘 다 쓰지 않는다
- **요청 크기 한도**: `PUT /admin/chalk/courses/:course/plan` 은 기존 authoring 라우트(`bodyLimit` 128KB, `authoring.ts:47`)와 별개 파일이므로 자기 한도를 따로 둔다. 요청 하나에 파일 하나(lesson 또는 ops), 파일당 **256KB**. 초과하면 413과 함께 `"계획서가 너무 큽니다"` 로 거부한다. E2-6 구현이 이 값을 지킨다
- **확정**: 확정 시점에 그 revision 의 계획서 행을 `ref_kind='version'` 으로 복사한다. `content.plan_ref.files` 의 sha256 이 확정본 바이트에 들어가므로 계획서가 바뀌면 확정본 해시와 어긋나 드러난다(VER-01 과 같은 효과). 확정 경로(`authoring.ts`)는 고치지 않으므로, 복사는 E5 확정 도구가 확정 직후 한다(스택 머지 뒤에는 스택 확정 서명 경로에 맞춘다)
- **읽기**: 계획서 원문은 issuer 전용 경로로만 나간다. 학생 경로·코치 프롬프트에는 `plan_ref` 만 간다
- 🔴 **시험(필수 부정 대조)**: 계획서가 있는 강의로 학생 토큰 대화를 열었을 때 코치 system prompt 와 `/v1/profile` 응답에 계획서 문장(교사 칸 문장 하나를 표본으로)이 **없다**
- 행 수가 revision 마다 늘어난다. 초안 revision 행 정리(최근 N 개만 남기기)는 E2-7(수정 이력) 설계에서 정한다

### 3-2. 생성기의 쓰기

- 초안을 여러 번 덮어쓸 때 생성기(도구 층)는 **최신 revision 을 읽고 `expected_revision` 으로 쓴다.** 충돌하면 다시 읽는다(재사용 평가 1-C)
- `request_id` 는 도구 호출마다 새로 만든다(멱등)

---

## 4. 저장 형식 새 칸 (SCH-01~03) — #1291

`SessionDesign` 에 선택 칸으로 더한다. 계획서가 원본이고, 이 칸들은 계획서에서 파생된다(E5-2). 검사는 이 칸을 읽는다.

| 칸 | 타입 | 계획서 출처 | 읽는 검사 |
|---|---|---|---|
| `steps[].duration_min` | `number` (분, 1~240) | 흐름 표 `data-duration-min` | G2-9 |
| `steps[].prohibited_moves` | `Array<{ family: 'P1'|'P2'|'P3'|'P4'; text: string }>` | 7절 `data-chalk-move` | G2-4 |
| `steps[].requires` | `string[]` | `data-chalk-requires` | G2-6 |
| `steps[].forbids` | `string[]` | `data-chalk-forbids` | G2-7 |
| `audience_tier` | `'lv1' | 'lv2' | 'adult'` | `chalk:audience-tier` | 관문 1 층 구분 |

- 🔴 이름 `scope` 를 쓰지 않는다(SCH-02). 볼트에서 `scope` 는 문서의 유효 범위다
- 🔴 기존 `steps[].evidence`(SX-18 유형 태그)와 계획서 4절 증거물을 **잇지 않는다**(SCH-03). 증거물은 계획서에만 있고, 필요하면 나중에 다른 이름의 칸을 만든다
- `prohibited_moves` 는 서버·강사만 본다. **학생 화면과 코치 프롬프트 원문(JSON 덤프)에 내보내지 않는다**(읽기 계약 §6). 🔴 코치 지시문은 확정본 `content` 를 `JSON.stringify(coachVisibleLesson(content))` 로 그대로 싣는다(`chat-gate.ts:300-320`). 그래서 **#1291 이 이 칸을 더하는 같은 PR 에서 `coachVisibleLesson()` 과 학생 쪽 lesson 전달에서 이 칸을 뺀다.** 칸 없는 옛 강의는 같은 참조가 그대로 나가 바이트가 바뀌지 않아야 한다(기존 계약, `learning-prompt.ts:66-80`). 코치가 금지 개입을 알아야 하면 E5 가 만드는 코치 지시문에 이름 붙은 문장으로 넣는다
- `requires`·`forbids` 의 값 공간(활동 `act-*` ID 인지 조건 키인지)은 볼트 `activities/` 가 0건이라 실물이 없다. 이번에는 문자열 배열로 받고 값 검사는 하지 않는다(열린 질문 Q4)

---

## 5. 시험 요구 (구현 이슈가 채울 것)

| 이슈 | 정상 대조 | 부정 대조 |
|---|---|---|
| #1288 | v1 적재 후 v2 추가, 둘 다 읽힘, v1 바이트 불변 | 학생 토큰 403 · 같은 버전 재적재 거부 |
| #1289 | 볼트 커밋 하나로 `method` 8건 + 어휘 3건, 출처 커밋 기록 | `family: reference` 제외 · 어휘 밖 값이면 SQL 파일이 나오지 않음 |
| #1290 | 표본 지도안에서 13절·단계·막힘·지원 추출 | 13절 없음 · 가족 수업인데 `parent` 없음 · 깨진 표식 → 위반과 위치 |
| #1291 | 새 칸을 채운 초안 저장·확정·재읽기 | 옛 확정본 바이트 불변 · `scope` 칸 없음 · 타입 틀리면 거부 |

---

## 6. 열린 질문 (구현 전에 리드가 닫는다)

| # | 질문 | 리드 기본값 |
|---|---|---|
| Q1 | 지식 버전 번호를 전역 하나로 둘까, 문서별로 둘까 | 전역 하나(스냅숏). 재현이 단순하다 |
| Q2 | 계획서 HTML 에 `<script>` 를 정말 0 으로 둘까(접기·목차 같은 편의) | 0. 편의는 CSS 만으로(`<details>`) |
| Q3 | ~~`plan.files` 를 `content` 안에 둘까~~ | **닫음**: 별도 테이블 `chalk_plan_files`. `content` 에 두면 코치 프롬프트와 학생 기기로 샌다(§3-1) |
| Q4 | `requires`·`forbids` 값 공간 | 이번에는 문자열 배열, 값 검사 없음. `act-*` 원자가 생기면 정한다 |
| Q5 | 운영 계획안 칸 세부 | E3 설계(#1282 하위)에서 확정 |

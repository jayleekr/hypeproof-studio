# 계획서에서 단계 목록·코치 지시문으로 바꾸는 규칙 설계

- 상태: 설계 (chalk-engineer 초안, 2026-09-24)
- 이슈: #1299 (상위 #1284)
- 요구: OUT-01 · OUT-05 · PRD 결정 2 · 3 · SCH-01~03
- 출발점: 볼트 `curriculum_wiki/design/lesson-plan-to-steps-mapping.md` (가져온 시점 기준). 이 문서는 그 규칙을 제품 규칙으로 옮기고, 볼트가 비워 둔 두 자리(힌트 출처 · 코치 지시문)를 채운다
- 전제: E1-1 계획서 규격 `chalk-plan/1`, 원문은 `chalk_plan_files`, `content` 에는 `plan_ref`

---

## 0. 독자가 셋이다

계획서 한 장에서 세 독자가 각자 다른 것을 받는다. **칸마다 누구에게 가는지 먼저 정하고, 그 밖으로는 절대 내보내지 않는다.**

| 독자 | 받는 것 | 어디에 실리나 |
|---|---|---|
| **학생** (학생 화면) | 학습자가 하는 일만 | `SessionDesign.steps[]` 의 `title` · `instructions` · `hint` · `acceptance`, `starter` |
| **코치** (AI, 학생과 대화) | 학생에게 어떻게 굴어야 하는지 | 새 칸 `coach_brief` (아래 3절) — 코치 system prompt 에 이름 붙은 문장으로 |
| **강사** | 전부 | 계획서 원문(`chalk_plan_files`), issuer 경로로만 |

- 🔴 확정본 `content` 는 학생 앱(`/v1/profile`, `chat.ts:283`)과 코치 프롬프트(`JSON.stringify(coachVisibleLesson(content))`, `chat-gate.ts:300-320`)로 **둘 다** 간다. 그래서 학생에게 가면 안 되는 것은 `content` 에 아예 넣지 않거나, 넣더라도 두 투영에서 뺀다
- `coach_brief` 는 코치에게는 가야 하지만 학생 앱에는 가면 안 된다 → `/v1/profile` 투영에서 뺀다(4절)

---

## 1. 금지 목록이 먼저다 — 학생에게 절대 가지 않는 것

볼트 변환 규칙 §2 를 그대로 제품 규칙으로 가져온다. **기계가 검사할 수 있는 모양**으로 적는다.

| 계획서 칸 | 학생에게 | 코치에게 | 검사 (변환 후, 실패 시 확정 거부 아님 — 변환기가 만들지 않는다) |
|---|---|---|---|
| 5절 흐름 `teacher` · `assistant` 칸 | ⛔ | ✅ (코치 행동 지침의 재료) | `steps[].instructions`·`hint` 가 teacher·assistant 칸 문장과 같거나 그 문장을 포함하면 실패 |
| 5절 흐름 `data-duration-min` | ⛔ (재촉 = P4) | ⛔ | 학생 필드에 "분"·남은 시간 표현이 계획서 시간과 함께 나오면 실패 |
| 5절 흐름 단계 제목(도입·전개N·정리) | ⛔ | — | `steps[].title` 이 `도입`·`전개\d*`·`정리`·`마무리` 와 같으면 실패 |
| 7절 금지 개입 | ⛔ | ✅ (코치가 하지 말 것) | 학생 필드에 금지 개입 문장이 있으면 실패 |
| 6절 핵심 발문 원문 | ⛔ | ✅ (던질 시점은 코치가 고름) | 학생 필드에 발문 원문이 그대로 있으면 실패 |
| 2절 성취기준 · 4절 평가 증거 원문 | ⛔ (기준 맞추기가 됨) | ⛔ | — (`acceptance` 는 3절 규칙으로 다시 씀) |
| 8절 발달구간 변형 | ⛔ | 해당 층 한 줄만 | — |
| 9절 가정 연계 · 11절 안전·법 | ⛔ | ⛔ | — |
| 12절 연결의 적용처 목록 | ⛔ (P1 선취) | ⛔ | 논의를 여는 질문만 코치에게 |
| 13절 `signal` · `expected-response` | ⛔ | ✅ | — |
| 운영 계획안 전체 | ⛔ | ⛔ | — |

- 이 표의 "검사" 열은 **변환기 자체 시험**(E5-2)이다. 확정 시점에 막는 검사가 아니다(강의 퀄리티 게이트는 후속). 변환기가 이런 결과를 내면 버그다
- 다른 코호트의 문장이 섞이는 것(9월 데모 사고)은 변환기가 계획서 밖에서 문장을 가져오지 않으면 생기지 않는다. 변환기는 **계획서 한 장만 입력으로 받는다**

---

## 2. 학생에게 가는 것 — `SessionDesign.steps[]`

| `steps[]` 칸 | 출처 | 규칙 |
|---|---|---|
| `id` | 5절 `data-chalk-step` | 그대로(안정 ID) |
| `title` | 5절 `learner` 칸 + 3절 본질적 질문 | **학생이 그 단계에서 하는 일**로 다시 쓴다. 강사 구조 용어 금지 |
| `instructions` | 5절 **`learner` 칸만** | 학생을 2인칭 주어로 다시 쓴다. 유일한 본문 출처 |
| `hint` | 🔴 **13절 `min-support` 만** | 단계에 딸린 막힘이 여럿이면 순서대로 잇는다. **13절이 비어 있으면 `hint` 는 빈 문자열**이다. 다른 칸에서 끌어오지 않는다(볼트 규칙 §4). 기존 스키마가 `hint` 를 필수 문자열로 요구하면 빈 문자열을 허용하도록 검증을 확인한다 |
| `acceptance` | 4절 평가 증거의 **관찰 가능한 결과물** | "무엇을 만들면 끝인가"로 다시 쓴다. 점수·등급·채점 표현 금지(OUT-05) |
| `duration_min` · `requires` · `forbids` | 5절 표식 | 그대로. 학생 화면에는 표시하지 않는다(시간 = P4) |
| `prohibited_moves` | 7절 | 저장은 하되 **학생 앱 투영·코치 JSON 덤프에서 뺀다**(E1-1 §4, #1291) |
| `help` · `ui` · `evidence` · `gate` | 기존 칸 | 계획서에 해당 표식이 없으면 넣지 않는다(기본 동작). `evidence` 를 4절 증거물과 잇지 않는다(SCH-03) |

수업 단위:

| `SessionDesign` 칸 | 출처 |
|---|---|
| `title` | 계획서 제목 |
| `audience` | 머리 `chalk:audience-tier` + 대상 입력 |
| `duration_minutes` | `chalk:duration-min` |
| `objective` | 3절 본질적 질문(학생에게 보여도 되는 유일한 목표 문장) |
| `prerequisites` | 1절 메타의 선행 조건 |
| `starter` | 10절 준비물 중 **주체가 학생인 것**만 |
| `audience_tier` | `chalk:audience-tier` |
| `plan_ref` | 계획서 sha256 · 지식 버전 · 모형 |
| `coach_brief` | 3절 |

---

## 3. 코치에게 가는 것 — `coach_brief` (결정 3 의 "코치 지시문")

### 3-1. 자리

- **`SessionDesign` 선택 칸 `coach_brief` 로 둔다.** 확정본에 들어가 버전과 함께 고정된다. 강의마다 코드를 고치고 배포하던 바이오팜 방식(코호트 프로필에 코치 지시문을 박음)에서 벗어나는 자리다
- 코치 프롬프트에는 **JSON 덤프가 아니라 이름 붙은 문장**으로 싣는다. 기존 `learningInstruction()` 이 `learning` 블록을 이름 붙은 문장으로 싣는 방식과 같다(`chat-gate.ts` SX-06~12). `coachVisibleLesson()` 은 JSON 덤프에서 `coach_brief` 를 빼고, 별도 함수가 문장으로 만든다
- 🔴 **코호트 프로필 지시문을 대체하지 않는다.** 프로필 지시문(안전·모더레이션·도구 경계·말투)은 그대로 먼저 오고, `coach_brief` 는 그 뒤에 **이 강의의 교수 지침**으로 붙는다. 안전 규칙은 강의가 덮을 수 없다

### 3-2. 모양

```ts
coach_brief?: {
  schema: 'chalk-coach-brief/1';
  lesson: {
    essential_question: string;          // 3절
    method_notes: string[];              // 고른 모형이 코치에게 요구하는 태도 (지식 method 문서에서)
    never: Array<{ family: 'P1'|'P2'|'P3'|'P4'; text: string }>;   // 7절 금지 개입 — 코치가 하지 말 것
    bridging_opener?: string;            // 12절 논의를 여는 질문 하나
  };
  steps: Array<{
    id: string;
    coach_role: string;                  // 5절 teacher·assistant 칸 → 코치의 행동 지침으로 다시 씀
    key_questions: string[];             // 6절 중 이 단계에 딸린 것 — 던질 시점은 코치가 판단
    stuck: Array<{
      expected: string;                  // 13절 expected-stuck
      signal: string;                    // 13절 signal
      min_support: string;               // 13절 min-support (학생 hint 와 같은 원문)
      expected_response: string;         // 13절 expected-response (리허설 기대 반응)
    }>;
  }>;
};
```

- `coach_role` 은 teacher 칸을 **그대로 옮기지 않는다.** "막힐 때만 되묻는다" 같은 강사 행동은 코치에게도 맞는 지침이지만, 강사 한 명·학생 여럿을 전제한 문장(예: "전체에게 묻는다", "보조 강사가 돈다")은 코치 1:1 대화로 다시 쓴다
- 부모 칸(`parent`)은 코치 지시문에 넣지 않는다(코치는 학생과 대화한다). 가족 수업의 부모 역할은 운영 계획안과 강사 몫이다

### 3-3. 리허설과 같은 원문

- 13절 한 칸이 세 곳으로 간다: 학생 `hint`(= `min_support`), 코치 `stuck`, 리허설 점검표(E6-5: `expected` 를 학생 입력 씨앗으로, `expected_response` 를 기대 반응으로)
- 그래서 리허설에서 "코치가 알맞게 답했나"를 판정할 기준이 **변환 전 원문과 같다.** 따로 적지 않는다

---

## 4. 투영 — 누가 무엇을 받나 (E5-2 · #1291 이 구현)

| 경로 | 지금 | 바뀐 뒤 |
|---|---|---|
| 코치 system prompt (`chat-gate.ts`) | `JSON.stringify(coachVisibleLesson(content))` (+ learning 문장) | `coachVisibleLesson()` 이 `plan_ref` 는 둬도 되고, **`prohibited_moves` · `coach_brief` 는 JSON 덤프에서 뺀다.** `coach_brief` 는 별도 함수가 이름 붙은 문장으로 싣는다 |
| 학생 앱 `/v1/profile` (`chat.ts:283`) | lesson 전체 | **`prohibited_moves` · `coach_brief` 를 뺀 투영.** 나머지는 그대로 |
| 확정본 바이트 / sha256 | `content` 전체 | 그대로 전체(투영은 전달할 때만) |

- 🔴 **두 투영 모두 "새 칸이 없는 옛 강의는 같은 참조를 그대로 돌려준다"** 를 지킨다. 기존 계약(`learning-prompt.ts:66-80`: 옛 강의 코치 프롬프트 바이트 불변)과 시험(`authoring.test.mjs`)이 깨지지 않아야 한다
- ⚠️ 스택 관계: `chat-gate.ts`·`chat.ts` 는 열린 원격 수업 PR 스택이 바꾼 파일이다(plan §4-1 R1). 투영 변경(E5-2)은 스택 머지 뒤에 하거나, 스택이 건드리지 않은 함수(`coachVisibleLesson` 은 `learning-prompt.ts`)에서만 한다. `/v1/profile` 투영은 `chat.ts` 라 스택 머지 뒤 — **E5-2 착수 시점을 이 이유로 정한다**

---

## 5. 시험 (E5-2 가 채움)

| | 무엇 |
|---|---|
| 정상 | 바이오팜 표본 계획서 → `steps[]` 와 `coach_brief` 가 나오고, 13절 `min_support` 가 `hint` 와 `coach_brief.steps[].stuck[].min_support` 에 같은 원문으로 있다 |
| 부정 1 | teacher 칸 문장이 `steps[].instructions`·`hint` 어디에도 없다 (표본의 teacher 칸 문장 전부로 대조) |
| 부정 2 | 13절이 빈 계획서 → `hint` 는 빈 문자열이고 다른 칸 문장이 들어가지 않는다 |
| 부정 3 | `steps[].title` 에 `도입`·`전개N`·`정리` 가 없다 |
| 부정 4 | 학생 토큰 `/v1/profile` 응답과 코치 system prompt JSON 부분에 `prohibited_moves`·`coach_brief` 원문이 없다. 코치 prompt 에는 `coach_brief` 가 이름 붙은 문장으로 있다 |
| 부정 5 | 새 칸 없는 옛 강의의 코치 prompt 바이트가 바뀌지 않는다 |
| 부정 6 | 점수·등급·0/1/2 채점 표현이 `acceptance` 에 없다(OUT-05) |

---

## 6. 열린 질문

| # | 질문 | 리드 기본값 |
|---|---|---|
| Q1 | 다시 쓰기(teacher → coach_role, learner → 2인칭)를 누가 하나 | 생성기(모델)가 계획서를 쓸 때 함께 쓴다. 변환기(E5-2)는 **결정적 함수**로 칸을 옮기고 검사만 한다. 모델 없이 돈다 |
| Q2 | `hint` 필수 여부 | 빈 문자열 허용. 기존 검증이 막으면 #1291 에서 완화 |
| Q3 | `coach_brief` 크기 상한 | 16KB. 넘으면 변환 실패로 알린다 |
| Q4 | 바이오팜처럼 코호트 프로필에 코치 지시문이 이미 박힌 수업 | 그대로 둔다. `coach_brief` 는 새로 만든 강의에서만 쓴다 |

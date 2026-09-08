# Intent-first Trial Diagnostic

## 목적

Studio 체험판의 첫 진입을 `무엇을 만들어 줄까?`에서 `사용자가 무엇을 하려는지 함께 명확하게 만드는 경험`으로 전환한다.

이 설계의 중심 자산은 **Intent**다. 그러나 첫 진입을 Intent 단일 테스트로 보지 않는다. Intent를 형성하는 과정에서 Context, Taste/Judgment, Delegate/Ownership의 초기 행동 신호도 함께 관찰하는 **embedded formative diagnostic**으로 정의한다.

## 왜 필요한가

기존 첫 화면은 사용자가 결과물 유형을 고르게 한다.

- 설명 자료 만들기
- 선택지 비교하기
- 반복 업무 줄이기

이 방식은 빠르게 작업으로 진입할 수 있지만, 시스템이 사용자의 Intent를 미리 추정한다. HypeProof가 Intent를 Human Asset으로 본다면 첫 체험은 Intent를 대신 정하는 것보다 사용자가 자신의 목적·성공 조건을 더 명확하게 표현하도록 도와야 한다.

또한 `AI 초급/중급/고급` 같은 자기평가 설문은 사용자의 실제 판단 방식을 보여주지 못한다. 첫 체험은 말로 주장한 숙련도가 아니라 실제 문제 정의·선택·검증·위임 행동을 근거로 해야 한다.

## 핵심 원칙

1. **Intent-first, not Intent-only**
   - 첫 병목은 Intent로 본다.
   - 다만 다른 자산은 실제 대화 속 행동 증거로 함께 관찰한다.

2. **Behavior over self-report**
   - `AI를 얼마나 잘 쓰나요?`를 묻지 않는다.
   - 사용자가 목적, 성공 기준, 경계를 어떻게 정의하는지 본다.

3. **Minimum necessary probing**
   - 체크리스트를 모두 묻지 않는다.
   - 다음 행동에 필요한 정보가 충분하면 바로 작업한다.
   - 사용자가 이미 목적과 성공 조건을 명확히 말했다면 재질문하지 않는다.

4. **One question at a time**
   - 심문형 onboarding을 피한다.
   - 실제 대화처럼 한 번에 한 가지 질문만 한다.

5. **No invented scoring**
   - 관찰 기능이 실제 evidence를 저장하지 못하면 숫자 점수나 mastery level을 만들지 않는다.

## 첫 세션 대화 모델

```text
Situation
  ↓
Intended change
  ↓
Existing model / context
  ↓
Success criteria
  ↓
Delegation boundary
  ↓
Action
  ↓
Artifact + Feedback
  ↓
Reflection
```

이 순서는 고정 wizard가 아니다. 필요한 단계만 사용한다.

### 1. Situation

질문 예:

> 지금 어떤 일이 막혀 있거나 달라졌으면 하나요?

목적은 결과물 종류를 고르게 하는 것이 아니라 현재 상황을 드러내는 것이다.

### 2. Intended change — Intent의 핵심

질문 예:

> 이 일이 끝났을 때 무엇이 달라져 있으면 좋겠어요?

여기서 산출물보다 `원하는 변화`를 먼저 잡는다.

### 3. Existing model / Context

질문 예:

> 지금까지는 이 일을 어떻게 해왔어요?

기존 방식, 자료, 제약을 파악한다.

### 4. Success criteria — Taste/Judgment

질문 예:

> 좋은 결과와 별로인 결과를 어떻게 구분할 수 있을까요?

사용자의 quality criterion을 드러낸다.

### 5. Delegation boundary

질문 예:

> 제가 대부분 만들어드릴까요, 아니면 중요한 판단은 같이 하면서 진행할까요?

이 질문은 단순 preference가 아니라 사용자가 AI autonomy boundary를 어떻게 생각하는지 볼 수 있는 probe다.

### 6. Action

정보가 충분하면 작은 실제 산출물로 이동한다. 진단 자체가 체험의 목적이 되면 안 된다.

## 초기 선택지 설계

결과물 카테고리 대신 **현재 상태**를 제시한다.

- 해야 할 일은 있는데 어디서 시작할지 모르겠어
- 이미 하고 있는 일이 있는데 더 잘하고 싶어
- AI에게 맡기고 싶은데 어디까지 맡겨야 할지 모르겠어

이 선택지는 라우팅 힌트일 뿐 고정 flow가 아니다. 자유 입력을 항상 우선한다.

## Human Asset 관찰 가설

| Asset | 첫 세션에서 관찰할 수 있는 행동 |
|---|---|
| Intent | 목적·대상·원하는 변화·완료 조건을 구체화하는가 |
| Context | 필요한 배경·제약·자료를 구분하는가 |
| Taste / Judgment | 좋은 결과의 기준과 선택 이유를 설명하는가 |
| Verify | 어떤 결과를 확인해야 하는지 구분하는가 |
| Delegate | AI에 맡길 범위와 직접 판단할 범위를 정하는가 |
| Iterate | 피드백을 기준과 연결해 수정하는가 |
| Ownership | 최종 결정과 책임을 자신의 것으로 가져가는가 |

이 표는 현재 working model이며 점수 체계가 아니다.

## Reflection

세션 종료 시 결과물 목록만 요약하지 않는다. 실제 경험에 맞는 질문 하나를 사용한다.

- 처음 생각과 지금 생각에서 무엇이 달라졌나요?
- AI가 제안한 것 중 받아들이지 않은 것이 있다면 왜 그랬나요?
- 다시 한다면 무엇을 직접 결정하고 무엇을 AI에게 맡기겠나요?

목적은 `Experience → Reflection → Growth` 루프를 닫는 것이다.

## 구현 단계

### Phase 1 — 이번 변경

- 체험판 welcome copy를 결과물 선택에서 상태 선택으로 변경
- system prompt에 Intent-first diagnostic policy 추가
- reflection policy 추가
- 숫자 점수 생성 금지 유지

### Phase 2 — 다음 구현 후보

- session-level `HumanAssetState` evidence schema
- 질문/응답이 아니라 **행동 증거** 저장
- asset별 `unknown / observed` 상태와 evidence source 기록
- coach가 이미 관찰된 내용을 반복 질문하지 않도록 adaptive question policy

### Phase 3 — 검증 후

- Human Asset maturity model을 실제 데이터로 검증
- knowledge mastery와 구분되는 `asset maturity` 정의
- Curriculum/Studio 간 evidence transfer 가능성 검토

## 성공 기준

Phase 1의 성공은 사용자가 더 많은 질문을 받는 것이 아니다.

- 첫 진입에서 결과물 유형을 고르지 않아도 자연스럽게 시작할 수 있다.
- 사용자의 목적이 이미 명확하면 코치가 곧바로 작업으로 이동한다.
- 목적이 모호하면 코치가 결과물을 대신 정하기 전에 최소 한 번 사용자의 원하는 변화를 묻는다.
- 한 번에 여러 진단 질문을 던지지 않는다.
- 코치가 숫자 skill/asset score를 지어내지 않는다.
- 작업 후 최소한 하나의 실제 사용자 판단을 반영한 수정 또는 선택이 발생할 수 있다.

## 비목표

- 첫 세션에서 7 Assets을 모두 측정하는 것
- 사용자를 레벨 1~5에 즉시 배정하는 것
- 모든 사용자를 같은 질문 순서로 통과시키는 것
- 진단을 완료해야만 작업할 수 있게 만드는 것

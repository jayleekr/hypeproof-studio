# Trial Onboarding — Product Intent to Requirement

## 문서의 위치

이 문서는 HypeProof Studio의 `Product Intent`를 체험판 첫 진입 요구사항으로 번역한 feature spec이다.

상태: #764의 설계 근거. 행동 계약의 원본은
[NAT-03 및 연관 요구사항](requirements/studio-native-trial.md#764에서-파생한-행동-계약),
수용 조건은 [T04 및 연관 검증](testing/studio-native-trial-validation.md#t04-product-intent-분기)이다.
이 문서의 단계는 설명을 위한 예시이며 필수 진단 순서가 아니다. 질문·성찰을 건너뛰는
경로도 같은 계약에 포함한다. 파일명은 기존 링크 호환을 위해 유지한다.

```text
HypeProof Philosophy
  ↓
Studio Product Intent
  ↓
Trial onboarding requirements
  ↓
Welcome UX / coach runtime behavior
  ↓
Observed evidence
```

여기서 `Product Intent`는 7 AI Native Assets 중 하나인 `INTENT`와 다르다. 이 체험판 요구사항은 Human Asset `INTENT` 하나를 측정하기 위해 존재하지 않는다. 상위 제품 의도인 **실제 일을 돕되 인간의 판단을 보이지 않게 만들지 않는다**를 첫 경험에 적용한 것이다.

## 상위 Product Intent

관련 canonical 문서: `docs/PRODUCT-INTENT.md`

이 기능이 구현하는 제품 원칙은 다음과 같다.

- Useful work first
- Human judgment stays visible
- Learning is embedded
- Minimum necessary intervention
- Evidence over claims
- Adapt, do not script

## 파생된 Product Requirement

#764 이전 첫 화면은 결과물 유형을 먼저 제안했다.

- 설명 자료 만들기
- 선택지 비교하기
- 반복 업무 줄이기

이 방식은 빠르지만 제품이 사용자의 문제를 너무 일찍 solution category로 프레이밍한다.

체험판 첫 진입은 다음 행동 계약을 가져야 한다.

1. **사용자가 이미 원하는 일을 명확히 말했다면 바로 작업한다.**
2. **모호할 때만 현재 상황과 원하는 변화를 최소한으로 묻는다.**
3. **제품이 결과물 유형을 먼저 확정하지 않는다.**
4. **AI 숙련도 자기평가 설문으로 시작하지 않는다.**
5. **질문은 한 번에 하나만 한다.**
6. **정보가 충분하면 진단을 계속하지 않고 실제 작업으로 이동한다.**
7. **작업 속 실제 선택·수정·검증·위임을 evidence로 본다.**
8. **세션 종료 시 필요하면 판단의 변화를 한 번 되돌아보게 한다.**

## 왜 첫 질문이 Human Asset INTENT와도 연결되는가

이 요구사항의 상위 이유는 Product Intent이지만, 첫 대화에서 가장 먼저 드러나기 쉬운 Human Asset은 `INTENT`다.

즉 관계는 다음과 같다.

```text
Product Intent
  "human judgment stays visible"
        ↓
Product Requirement
  "제품이 사용자의 목표를 대신 정하지 않는다"
        ↓
UX behavior
  "모호하면 원하는 변화를 묻는다"
        ↓
Observable Human Asset evidence
  INTENT + Context + Taste + Delegate ...
```

따라서 이 기능을 `Intent 기능`이라고만 부르면 추적성이 뒤집힌다. Human Asset INTENT는 **관찰 대상 중 하나**이고, Product Intent는 **요구사항의 설계 근거**다.

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

### Situation

질문 예:

> 지금 어떤 일이 막혀 있거나 달라졌으면 하나요?

### Intended change

질문 예:

> 이 일이 끝났을 때 무엇이 달라져 있으면 좋겠어요?

이 단계에서 Human Asset `INTENT`의 행동 신호가 드러날 수 있지만, 질문의 목적은 점수를 매기는 것이 아니라 실제 작업의 방향을 사용자가 소유하게 하는 것이다.

### Existing model / Context

> 지금까지는 이 일을 어떻게 해왔어요?

### Success criteria / Taste-Judgment

> 좋은 결과와 별로인 결과를 어떻게 구분할 수 있을까요?

### Delegation boundary

> 제가 대부분 만들어드릴까요, 아니면 중요한 판단은 같이 하면서 진행할까요?

### Action

정보가 충분하면 작은 실제 산출물로 이동한다. 진단 자체가 체험의 목적이 되면 안 된다.

## 초기 선택지

결과물 카테고리 대신 현재 상태를 제시한다.

- 해야 할 일은 있는데 어디서 시작할지 모르겠어
- 이미 하고 있는 일이 있는데 더 잘하고 싶어
- AI에게 맡기고 싶은데 어디까지 맡겨야 할지 모르겠어

이 선택지는 라우팅 힌트일 뿐이며 자유 입력이 항상 우선한다.

## 관찰 가능한 Human Asset evidence

| Asset | 실제 작업에서 볼 수 있는 행동 |
|---|---|
| INTENT | 목적·대상·원하는 변화·완료 조건을 구체화하는가 |
| Context | 필요한 배경·제약·자료를 구분하는가 |
| Taste / Judgment | 좋은 결과의 기준과 선택 이유를 설명하는가 |
| Verify | 어떤 결과를 확인해야 하는지 구분하는가 |
| Delegate | AI에 맡길 범위와 직접 판단할 범위를 정하는가 |
| Iterate | 피드백을 기준과 연결해 수정하는가 |
| Ownership | 최종 결정과 책임을 자신의 것으로 가져가는가 |

이 표는 scoring model이 아니다.

## Reflection

세션 종료 시 결과물 목록만 요약하지 않는다. 실제 경험에 맞을 때 질문 하나를 사용한다.

- 처음 생각과 지금 생각에서 무엇이 달라졌나요?
- AI가 제안한 것 중 받아들이지 않은 것이 있다면 왜 그랬나요?
- 다시 한다면 무엇을 직접 결정하고 무엇을 AI에게 맡기겠나요?

## 성공 기준

- 사용자의 목적이 명확하면 추가 onboarding 없이 바로 작업한다.
- 목적이 모호하면 결과물을 대신 정하기 전에 원하는 변화를 최소 한 번 묻는다.
- 한 번에 여러 진단 질문을 던지지 않는다.
- 결과물 선택 카드가 사용자의 문제를 특정 solution type으로 고정하지 않는다.
- 숫자 skill/asset score를 지어내지 않는다.
- 실제 작업 중 최소 하나 이상의 사용자 판단·선택·수정이 드러날 수 있다.

## 비목표

- Human Asset `INTENT` 단독 테스트
- 첫 세션에서 7 Assets 전부 측정
- Level 1–5 즉시 배정
- 모든 사용자를 같은 질문 순서로 통과시키는 wizard
- 진단을 완료해야 작업할 수 있게 하는 것

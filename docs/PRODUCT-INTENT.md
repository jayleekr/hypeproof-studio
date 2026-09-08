# HypeProof Studio — Product Intent

> Status: working product-intent layer
> Upstream: [HypeProof Lab philosophy, 6845cdb4](https://github.com/jayleekr/hypeprooflab/blob/6845cdb4391273d16ed09419eee806b0c03c04f9/PHILOSOPHY.md)
> Downstream: [Studio behavior requirements](studio-requirements.md) and feature-specific specs

[철학 개정 적용 기록](design/philosophy-alignment-2026-09-08.md)은 Lab 원본의 의미를
제품에 연결한다. 이 문서는 자산 정의나 Lab Mission을 새로 소유하지 않는다.

## 역할

이 문서는 철학과 제품 요구사항 사이의 번역 계층이다.

```text
Philosophy
  ↓
Product Intent
  ↓
Product Principles / Requirements
  ↓
UX + Runtime Behavior
  ↓
Evidence
  ↓
Philosophy / Intent refinement
```

여기서 **Product Intent**는 7 AI Native Assets 중 하나인 `INTENT`와 다른 개념이다.

- `INTENT` (Human Asset): 사용자가 자신이 원하는 것을 알고 표현하는 능력
- `Product Intent`: HypeProof 철학을 Studio가 어떤 사용자 경험과 행동 변화로 구현해야 하는지 설명하는 설계 의도

두 용어를 문서와 코드 리뷰에서 혼용하지 않는다.

## Studio의 Product Intent

HypeProof Studio는 AI가 일을 대신 처리하는 속도만 높이는 도구가 아니라, 사용자가 실제 일을 AI와 함께 수행하는 과정에서 **자신의 목적을 더 명료하게 만들고, 결과를 판단하고, 적절히 위임하고, 검증하고, 최종 결과를 책임지는 경험**을 제공해야 한다.

Studio는 사용자의 사고를 대신 완성하는 것이 아니라, 필요한 순간에 판단을 드러내고 연습하게 해야 한다. 동시에 학습을 위해 사용자의 일을 불필요하게 늦추거나 고정된 교육 절차를 강요해서는 안 된다.

따라서 Studio의 기본 제품 의도는 다음 긴장을 함께 만족시키는 것이다.

1. **Useful work first** — 실제 사용자의 일을 끝낸다.
2. **Human judgment stays visible** — 목적·선택·검증·위임·책임의 핵심 지점에서 인간의 판단이 사라지지 않게 한다.
3. **Learning is embedded** — 별도 시험보다 실제 작업 속 행동에서 학습과 관찰이 일어난다.
4. **Minimum necessary intervention** — 이미 명확한 사용자를 교육 흐름에 가두지 않는다.
5. **Evidence over claims** — 자기평가나 칭찬이 아니라 실제 선택·수정·검증·결과에서 학습 증거를 찾는다.
6. **Adapt, do not script** — 같은 질문 순서를 강제하지 않고 현재 상태와 이미 드러난 정보에 적응한다.
7. **Assets are hypotheses, not UI labels** — 7 Assets은 제품 설계와 관찰의 working model이며 모든 화면에 이름을 노출할 필요는 없다.

## 첫 체험에 대한 Product Intent

체험판의 첫 경험은 `AI가 무엇을 만들어줄 수 있는지`를 카탈로그처럼 고르게 하는 데서 시작하지 않는다.

먼저 사용자가 처한 상황과 원하는 변화를 최소한으로 명료하게 만든 뒤, 실제 작업으로 이동한다. 이 요구는 Human Asset `INTENT` 하나를 시험하기 위한 것이 아니라, Studio의 더 상위 Product Intent인 **human judgment stays visible + learning is embedded**에서 파생된다.

따라서 첫 체험은 다음을 만족해야 한다.

- 사용자가 이미 원하는 일을 명확히 말하면 바로 시작한다.
- 모호할 때만 `무엇이 달라지면 성공인가`를 묻는다.
- 결과물 종류를 제품이 먼저 확정하지 않는다.
- AI 숙련도 자기평가 설문으로 시작하지 않는다.
- 작업 도중 Context, Taste/Judgment, Verify, Delegate, Iterate, Ownership의 행동 증거가 자연스럽게 나타날 수 있게 한다.
- 세션 종료 시 결과물뿐 아니라 사용자가 내린 판단의 변화도 되돌아볼 수 있게 한다.

세부 요구사항과 수용 기준은 `docs/studio-requirements.md` 및 feature spec을 따른다.

## 요구사항 파생 규칙

새 Product Requirement는 가능하면 다음 추적성을 가진다.

```text
Philosophy claim
  → Product Intent / principle
    → REQ-###
      → implementation
        → test / observed evidence
```

PR에서 Studio behavior를 변경할 때는 단순히 "어느 Human Asset인가"만 쓰지 말고, 가능하면 **어느 Product Intent를 구현하는지**와 관련 REQ를 함께 적는다.

Human Asset은 철학적/학습적 모델이고, Product Intent는 제품 설계 판단의 중간 계층이며, Product Requirement는 검증 가능한 행동 계약이다.

## 현재 요구사항으로의 추적

아래는 기존 요구사항에 대한 매핑이다. 요구사항을 연결했다는 사실은 구현·실행·학습
효과를 입증하지 않는다. NAT는 개인 체험의 동작, AE는 수업 Agent 경험의 계획을 소유한다.
`INT-AE-*`는 기능별 설계 의도이며 이 상위 Product Intent를 대체하지 않는다.

| Product principle | 검증 가능한 행동 계약 | 검증 위치 |
|---|---|---|
| Useful work first / Minimum necessary intervention / Adapt, do not script | NAT-03; AE-01/02/36/41. 충분하면 실행, 부족할 때 필요한 질문 하나, 목표 변경·질문 건너뛰기 수용 | T04 분기; AE-T01/28/31 |
| Human judgment stays visible | NAT-04/05/07; AE-07/08/09/27. 이름·역할·모델·실제 권한 분리, 제안과 채택 및 위임 결과의 주체 보존 | T07/09/15; AE-T05/06/19/25 |
| Learning is embedded / Evidence over claims | NAT-06/08/09; AE-24/34/42/43/44. 실제 출처·도움·미관찰을 구별하고 사람 피드백·전이를 따로 검증 | T11–18/25; AE-T18/26/34/37/38 |
| Assets are hypotheses, not UI labels | NAT-08/09; AE-35/36/38. 필수 설문·자동 자산 점수 없이 필요한 판단을 작업 안에서 돕는다 | T04/17/18/25; AE-T27/28/30 |

행동의 원본은 [NAT 요구사항](requirements/studio-native-trial.md),
[AE 요구사항](requirements/learning-agent-experience.md)이며,
[NAT 검증](testing/studio-native-trial-validation.md),
[AE 검증](testing/learning-agent-experience.md)에서 실행 근거를 추적한다.
[다음 구현 순서](plan/learning-agent-experience-epics.md#product-intent에서-다음-구현으로)는
이 원칙을 채팅·강사 설정·SDK·Browser/Computer Use·멀티모델에 적용한다.

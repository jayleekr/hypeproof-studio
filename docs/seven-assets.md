# HypeProof — 7 AI Native Assets

> 철학과 자산 정의의 정본은 [hypeprooflab/PHILOSOPHY.md](https://github.com/jayleekr/hypeprooflab/blob/main/PHILOSOPHY.md)다.
> 이 문서는 Studio의 참조·구현 호환 인덱스다. `docs/essence-v0.1.md`의 16 essence 체계는 계속 폐기 상태다.

Status: Legacy implementation reference; Lab #782 research framework merged; measurement migration pending
Owner: Jay
Date: 2026-09-08
Verified upstream: [6845cdb4](https://github.com/jayleekr/hypeprooflab/blob/6845cdb4391273d16ed09419eee806b0c03c04f9/PHILOSOPHY.md)

2026-09-08 철학의 §6이 자산 정의를, §7이 제품 역할을, §8~9가 교육철학 계보와
AI Discontinuity를, §11이 연구 질문을 소유한다. 이는 위 pinned revision의 설명이다.
[Lab #777](https://github.com/jayleekr/hypeprooflab/issues/777)은 기존 일곱 개를 Candidate Model 0으로
두고 상위 Human Capability Research와 v1 후보를 제안했다. 문서 기준은
[Lab #782 · 1de0d9b8](https://github.com/jayleekr/hypeprooflab/blob/1de0d9b84ee51880ef9fcc70688b18c1afa4ac4e/PHILOSOPHY.md)로 병합됐다.
아래 역사적 핀·절 번호·enum을 새 정의로 바꾸지 않으며, 후보 타당화와 측정 구현은 별도다.
일곱 자산은 수정 가능한 연구 모델이며
기능 사용·산출물 완성만으로 성장했다고 판정하지 않는다. 철학의 Human Assets와
대외/Studio UI의 **7 AI Native Assets**는 그 역사적 revision에서 같은 대상을 가리킨다.
새 용어를 이 호환 인덱스의 enum이나 과거 점수로 자동 이식하지 않는다.
[새 측정 계약](requirements/capability-model-contract.md)과
[채택 순서](plan/capability-and-pricing-epics.md)를 따른다.

아래 절 번호·기존 이름·구현 키는 기존 REQ와 이벤트 참조의 호환성을 위해 유지한다.
새 정의를 이곳에 복제하거나 코드의 enum·기록을 일괄 개명하지 않는다.

---

## 1. Taste

정본 §6: **TASTE · 보는 눈**. 기존 구현 키: `taste`.

## 2. Intent clarity

정본 §6: **INTENT · 의도**. 기존 구현 키: `intent_clarity`.

## 3. Context design

정본 §6: **CONTEXT · 맥락**. 기존 구현 키: `context_design`.

## 4. Verification reflex

정본 §6: **VERIFY · 검증**. 기존 구현 키: `verification_reflex`.

## 5. Delegation judgment

정본 §6: **DELEGATE · 위임**. 기존 구현 키: `delegation_judgment`.

## 6. Iteration reflex

정본 §6: **ITERATE · 반복**. 기존 구현 키: `iteration_reflex`.

## 7. Ownership

정본 §6: **OWNERSHIP · 주인의식**. 기존 구현 키: `ownership`.

---

제품 적용을 위한 제안과 증거: [수업별 Agent 경험 디자인](design/learning-agent-experience.md),
[2026-09-08 경쟁 제품 비교·화면 관측](research/agent-experience-2026-09-08/README.md).
동기화 근거: [2026-09-08 철학의 제품 적용 결정](design/philosophy-alignment-2026-09-08.md).
기능별 채택·구현 여부는 연결된 요구사항과 실행 증거를 따른다.

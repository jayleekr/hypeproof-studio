# PROJECT_RULES: 학습 경험 우선 Studio 구현 규칙

> 작성일 2026-09-18 · 상태: 활성 · 요구의 정본은 `docs/requirements/studio-learning-experience.md`다. 이 파일은 구현자가 매번 확인할 짧은 목록이다.

## 범위

- 건드리는 곳: `extensions/hypeproof-chat/` (호스트 + 웹뷰), `worker/src/lib/measurement-core/` (이벤트·필드 확장만), `chalk/` (세션 설계 파일 스키마와 예시 데이터), `docs/**`, `config/traceability.json`, `e2e/`, `extensions/hypeproof-chat/test/`.
- 건드리지 않는 곳: `vscodium-base/`, Worker 라우트의 인증·예산·결제, 기존 코호트 프로필, 기존 수업 정책, `proxy-poc/`, Lab 저장소.

## 반드시

- 작업 중 화면(스레드 실행 중, 에디터 포커스, canvas)에 숫자 점수·등급·배지·퍼센트·"개선 필요"가 없다. DOM 검사로 증명한다(SX-T05, T40, T45).
- 학생 홈 첫 화면 위에서 아래로: 주차·미션 한 문장 → 지금 할 1~3개 action → 지난번 이어서. 성장 링크는 그 아래, 작은 크기(SX-01~03).
- 한 화면에 Primary CTA 1개(SX-04). 상태는 아이콘 + 문구(SX-50). 모달보다 inline(SX-52).
- 기대 조건 전 완료 불가(SX-14). 재확인 없이 검증 완료 없음(SX-15).
- real / simulated / self_reported / unverified 를 저장 시점에 고정하고 UI에 라벨(SX-21, SX-46).
- 회고는 제출·세션 종료·주차 종료에서만, "바뀐 생각 1개 + 다음 실험 1개"(SX-25~27).
- 관찰 이벤트는 measurement-core 확장. AI 작성 텍스트는 학생 행동으로 기록하지 않는다(SX-45, SX-48).
- 6주 내용은 세션 설계 파일에서 읽는다. 주차·미션·완료 조건을 코드 상수로 넣지 않는다(SX-56).
- 카피: 학생 화면 합니다체, 관찰 문장은 행동이 주어, 원문 Appendix의 "쓴다" 열 우선. 금지 라벨 lint(SX-12, SX-35).
- 새 화면마다 e2e 또는 smoke 테스트 1개 이상. 계측기가 실물을 재는지 먼저 확인(`.claude/rules/verification.md` 규칙 1).

## 절대

- 새 점수, 새 채점기, 제2 저장소, 랭킹, 스트릭, 배지.
- "성장" 을 사람에 대한 주장으로. 화면 이름은 "나의 변화 기록".
- 원문 `ui-philosophy-2026-09-18.md` 수정.
- 요구 문장의 뜻 변경. 개정 제안은 `STATE.md`로.
- 테스트 단언 완화.

## 참고 위치

- 기존 개선 행동 루프: `extensions/hypeproof-chat/webview-ui/src/LocalReview.tsx` ("다음 작업에서 바꿀 행동 하나", 후속 결과 저장). P2는 이것을 재사용한다.
- 구형 상태바: `extensions/hypeproof-chat/src/assetStatusBar.ts`, `assetStatus.ts`, `hypeproof-chat.showAssetHistogram` 커맨드(`package.json`). P0에서 제거.
- 관찰 코어: `worker/src/lib/measurement-core/`. 계약 문서 `docs/requirements/measurement-core.md` MC-07~20.
- 층 규칙: `docs/plan/vessel-and-modules.md` §1.
- Lab 측정 제안서(참고): hypeprooflab `products/studio/2026-09-17-measurement-ux-proposal.md`.

---
title: Studio Requirements
product: studio
doc_type: requirements
status: canonical
owner: core
version: 0.1.5
last_reviewed: 2026-05-22
audience: maintainers
source_paths:
  - docs/studio-requirements.md
  - extensions/hypeproof-chat/src
  - e2e/tests
quality_gates:
  - requirement-ids-present
  - acceptance-criteria-present
  - source-paths-exist
---

# Studio Requirements

## Requirement Index

The canonical detailed table remains `docs/studio-requirements.md`. This page is
the developer-facing summary that maps requirement families to code ownership
and test gates.

| ID | Area | Acceptance criteria | Primary paths |
|---|---|---|---|
| REQ-STUDIO-AUTOONBOARD | first launch | workspace opens, trust suppressed, chat panel focused, token prompt shown when needed | `extension.ts`, `chatPanelProvider.ts` |
| REQ-STUDIO-LESSON | course delivery | signed immutable lesson shown in chat and chosen task inserted into draft without automatic execution | `protocol.ts`, `ChatPanel.tsx`, `worker/src/routes/authoring.ts` |
| REQ-STUDIO-AUTH | token/profile | invalid tokens are classified; raw JSON is never exposed to members | `proxyClient.ts`, `worker/src/routes` |
| REQ-STUDIO-CHAT | streaming chat | Korean response streams within timeout; retry/cancel/history behave predictably | `proxyClient.ts`, `chatPanelProvider.ts` |
| REQ-STUDIO-PREVIEW | generated artifact | last HTML opens in sandboxed preview and writes workspace `index.html` | `previewProvider.ts`, `cspBuilder.ts` |
| REQ-STUDIO-ISSUER | workshop token mint | issuer token is stored, invalidated on auth failure, and never leaked | `mintStudentToken.ts`, `worker/src/routes/admin.ts` |
| REQ-STUDIO-REPORT | support report | member report includes safe metadata and request id without raw JTI | `reportProblem.ts`, `worker/src/routes/report.ts` |
| REQ-STUDIO-RELEASE | installable app | display name, bundle id, data folder, and branding pass verification | `scripts/verify-branding.sh` |

## Acceptance Policy

Product decisions follow [Philosophy → Product Intent](../PRODUCT-INTENT.md) →
existing requirement → UX/runtime behavior → observed evidence. Product Intent
is distinct from the Human Asset `INTENT` and feature-level `INT-AE-*` identifiers.
The trial entry contract refines [NAT-03](../requirements/studio-native-trial.md):
act when sufficient, ask one necessary question per turn while uncertainty remains, and support skipping
questions within existing permission limits. See T04 and linked NAT tests;
do not introduce a second requirement or learner-state system for #764.

Every stable requirement must have an acceptance criterion that a reviewer can
verify without guessing the author's intent. If the behavior can be isolated
from VS Code APIs, the acceptance criterion should be covered by a unit smoke
test. If it depends on real webview focus, panel state, or Electron lifecycle,
it belongs in Playwright Electron. If it depends on deployed Worker behavior, it
belongs in rehearsal tests.

## Change Control

New behavior gets a new `REQ-STUDIO-*` row before implementation is considered
complete. Changed behavior updates the row and the test command in the same PR.
Removed behavior is deleted from the table and called out in release notes if a
member, instructor, or release owner could observe the change.

## Chalk Authoring Proposal

Related proposal: [Learning Agent Experience requirements](../requirements/learning-agent-experience.md)
connect competitive UI evidence to lesson-specific AI identity, chat, runtime
policy, SDK lifecycle, browser verification, instructor operations, Computer Use
and lesson-governed multi-model selection, routing and comparison.
AE-01 through AE-44 are proposed acceptance goals, not implemented contracts.
The refinement adds learner comparison, assistance transitions, verification
freshness, separate completion states, post-class ownership, help triage,
context exclusion on resume, and evidence-linked curriculum revision.
[The test plan](../testing/learning-agent-experience.md) and
[seven epics](../plan/learning-agent-experience-epics.md) retain that distinction.
Existing Studio, Chalk authoring and classroom-admin requirements remain in force.

[Chalk authoring requirements](../requirements/chalk-authoring.md) contain the
planned course-authoring scope. Their BASE/CH/WEB/ENV/RUN/CLS/EDU/REQ and architecture
IDs are local to that document and retain the discussion's identifiers.
They do not replace existing REQ-STUDIO-* or REQ-* behavior contracts.

[Chalk test requirements](../testing/chalk-authoring.md) map those local IDs to
T-01 through T-23. Implementation PRs must link the applicable row, update the
canonical Studio behavior table when App behavior changes, and record actual
execution evidence. Do not mark the whole proposal implemented when a single
slice lands. Existing Chalk console/issuer/board are reusable implementations;
their presence does not prove authoring, rehearsal, or student project access.

### Authoring API slice

| ID | Acceptance criteria | Primary paths |
|---|---|---|
| REQ-STUDIO-AUTHORING-API | Scoped owner can save/reopen a draft with revision conflicts and freeze an immutable, inactive session-design document. | worker/src/routes/authoring.ts; worker/test/authoring.test.mjs |

Contract and storage decision: [ADR 0004](../adr/0004-chalk-authoring-storage.md). This backend slice does not claim the full authoring UI or live classroom flow.

### Dental course generation

| ID | Acceptance criteria | Primary paths |
|---|---|---|
| REQ-STUDIO-DENTAL-AUTHORING | Five persona-specific course drafts compile through the Service schema, persist/reopen, and resume without overwriting instructor edits. Learning outcomes remain unassessed until observed. | docs/curriculum/dental-ownership/program.json; worker/scripts/dental-authoring.mjs; worker/test/dental-course-automation.test.mjs |

| ID | Acceptance criteria | Primary paths |
|---|---|---|
| REQ-STUDIO-DENTAL-REFERENCE | Browser evidence for all five levels with positive/negative controls; loopback release/backup simulation never reported as Studio or production execution. | e2e/dental-reference/run.mjs; docs/curriculum/dental-ownership/reference/README.md |

`REQ-STUDIO-PREVIEW-WIDTH`: local HTML layout inspection via the existing App live server, 390px/1280px/original. The shipped shell ignores CDP device metrics, so a same-origin iframe provides the CSS viewport. This is manual visual verification and does not grant SDK tools or change Service profile policy.

Chalk authoring Surface: `REQ-STUDIO-CHALK-AUTHORING-UI`, `/authoring` form with Service-owned draft/version writes; browser contract in `e2e/chalk-authoring/run.mjs`. Support submission remains the existing GitHub workflow.


## Classroom administration

- [ADM-01~14](../requirements/classroom-admin.md)
- [DES-01~12](../requirements/classroom-design.md)
- [AT/DT tests](../testing/classroom-admin.md)

## Public trial

| ID | Acceptance criteria | Primary paths |
|---|---|---|
| REQ-STUDIO-TRIAL-EVIDENCE | Versioned structured observations explain 7 assets; unknown and coached evidence never fabricate independent growth. | worker/src/lib/trial-evidence.ts; worker/test/trial-evidence.test.mjs |

Detailed contract: [studio-trial](../requirements/studio-trial.md).

## Native Studio trial (#744)

| ID | Acceptance criteria | Implementation / verification |
|---|---|---|
| REQ-STUDIO-NATIVE-EVENTS | Host roles, task/session/program IDs and actual tool decisions survive replay; missing records are explicit and cannot be assessed. | nativeObservationRecorder.ts; worker/test/native-observation.test.mjs |
| REQ-STUDIO-NATIVE-OBSERVATION | Seven provisional observations cite exact source events, retain unobserved assets and distinguish help; no numeric score or unsupported independence. | worker/src/routes/observations.ts; NativeObservationPanel.tsx; native-trial-live.spec.ts |
| REQ-STUDIO-NATIVE-LIFETIME | Existing issuer flow grants a fixed individual window, attempt allowance and atomic concurrency; reissue cannot reset them. | native-trial-grants.ts; native-trial-grants.test.mjs; native-trial-d1.test.mjs |

[NAT-01–12](../requirements/studio-native-trial.md) define the product scope; [T01–25](../testing/studio-native-trial-validation.md) define acceptance tests.
[Executed laptop evidence](../testing/studio-native-trial-results-2026-09-08.md) records real App/API results separately from synthetic and human validation.

## Personal trial UI and UX (#758)

`REQ-STUDIO-NATIVE-UX`: [TUX requirements](../requirements/studio-native-trial-ux.md) inventory every native trial control, conditional surface and host action. [UI acceptance tests](../testing/studio-native-trial-ux.md) distinguish React interaction, host contracts, actual Electron/API execution and release verification. Requirements are not executed results.

## 체험 대화와 GitHub 연결 (#844)

[CU-01~18 / GHX-01~12](../design/trial-conversation-experience.md)는 NAT/TUX/AE의 후속 수용 기준이다.
[테스트 계획과 실행 기록](../testing/trial-conversation-experience.md), [화면 근거](../research/trial-conversation-2026-09-08/README.md)를 함께 유지한다.
전체 구현 완료로 표시하지 않는다. #842의 목적별 빈 폴더 시작만 이번 구현 범위다.

- 수업 effort (#799): [REQ-M40](../studio-requirements.md), [설계와 경계](../design/model-effort-and-course-usage.md#수업-effort-구현-계약-799), [실행 범위](../testing/lesson-effort.md). 사용량·예산 #800의 완료와 구분한다.

운영자 사용량 관측: REQ-L5 · [감사와 읽기 계약](../design/usage-observation-audit.md) · [검증](../testing/usage-observation.md). 예약/정산·역할별 예산은 #800 후속이며 미구현이다.

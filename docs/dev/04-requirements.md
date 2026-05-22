---
title: Studio Requirements
product: studio
doc_type: requirements
status: canonical
owner: core
version: 0.1.4
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
| REQ-STUDIO-AUTH | token/profile | invalid tokens are classified; raw JSON is never exposed to members | `proxyClient.ts`, `worker/src/routes` |
| REQ-STUDIO-CHAT | streaming chat | Korean response streams within timeout; retry/cancel/history behave predictably | `proxyClient.ts`, `chatPanelProvider.ts` |
| REQ-STUDIO-PREVIEW | generated artifact | last HTML opens in sandboxed preview and writes workspace `index.html` | `previewProvider.ts`, `cspBuilder.ts` |
| REQ-STUDIO-ISSUER | workshop token mint | issuer token is stored, invalidated on auth failure, and never leaked | `mintStudentToken.ts`, `worker/src/routes/admin.ts` |
| REQ-STUDIO-REPORT | support report | member report includes safe metadata and request id without raw JTI | `reportProblem.ts`, `worker/src/routes/report.ts` |
| REQ-STUDIO-RELEASE | installable app | display name, bundle id, data folder, and branding pass verification | `scripts/verify-branding.sh` |

## Acceptance Policy

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

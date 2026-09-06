---
title: Studio Testing Requirements
product: studio
doc_type: testing
status: canonical
owner: core
version: 0.1.5
last_reviewed: 2026-05-22
audience: maintainers
source_paths:
  - e2e
  - tests/rehearsal
  - worker/test
quality_gates:
  - unit-layer-present
  - e2e-layer-present
  - executable-commands
---

# Studio Testing Requirements

## Test Layers

Studio uses four layers. Unit tests cover pure helper logic such as CSP strings,
history clamps, token parsing, request metadata, and update banner decisions.
Electron e2e tests cover the real app, real webviews, focus behavior, preview
panels, and user flows. Rehearsal tests cover live Worker contracts and token
lifecycle. Manual checks remain for signed app packaging and visual branding
until those checks are fully automated.

## Commands

```bash
# Extension and helper smoke tests where available
cd extensions/hypeproof-chat
npm test

# Playwright Electron e2e
cd ../../e2e
npm install
npm test

# Worker smoke tests
cd ../worker
npm install
npm test

# Live rehearsal API contract
cd ../tests/rehearsal
npm install
npm test

# Docs contract
cd ../..
python3 scripts/docs-harness/check.py --min-score 95
```

## Release Gate

A Studio release cannot ship on unit tests alone. The minimum gate is docs
contract, branding verification, Electron launch/chat/preview coverage, and
Worker token lifecycle smoke. If a failure is waived for a workshop, the waiver
must name the failing test, the affected cohort, the workaround, and the rollback
decision. A flaky test must be quarantined with an issue and a replacement
manual check, not silently removed from the gate.

## Chalk Authoring Verification

Use [the authoring test plan](../testing/chalk-authoring.md) for the proposed
cross-layer workflow. Unit tests cover state transitions, API integration tests
cover authorization and persistence, and e2e covers real user navigation and
project execution. A documented acceptance scenario starts as NOT RUN.

For Chalk changes, use the package's existing test commands after installing
the owning dependencies:

```bash
(cd worker && npm ci)
(cd chalk && npm ci && npm test && npm run typecheck)
```

Select only the layers affected by a change. Documentation-only changes use the
docs checker and local-link/requirement-reference checks; they do not require
an app rebuild. Record baseline failures separately from new findings without
lowering the checker threshold. Preserve the verification rule's positive and
negative controls for any new detector. No new test script should print PASS
for a placeholder, skipped implementation, or missing external environment.

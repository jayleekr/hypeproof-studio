---
title: Studio Testing Requirements
product: studio
doc_type: testing
status: canonical
owner: core
version: 0.1.4
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

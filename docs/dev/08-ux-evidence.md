---
title: Studio UX Evidence
product: studio
doc_type: ux-evidence
status: canonical
owner: core
version: 0.1.4
last_reviewed: 2026-05-22
audience: product reviewers
source_paths:
  - docs/curriculum-snapshots/boah-dental-v4
  - e2e/tests/99-screenshots.spec.ts
quality_gates:
  - screenshots-present
  - scenario-coverage
  - source-paths-exist
---

# Studio UX Evidence

## Evidence Set

The current evidence set is the Boah Dental v4 workshop capture under
`docs/curriculum-snapshots/boah-dental-v4`. It includes PNG screenshots such as
`01-greeting.png`, `02-chip-pick.png`, `07-verdict.png`, and
`10-roll-input.png`. These screenshots are product evidence, not decoration.
They show whether the panel expresses the intended workshop flow, whether the
coach tone and choice chips are legible, and whether the generated artifact path
is understandable to a participant.

## Capture Standard

Evidence should be captured from the same flow that release tests exercise.
Prefer Playwright screenshots when the UI state is deterministic. Use GIF only
when motion or stream progression is the point of the evidence. A new UX
evidence set needs scenario name, cohort/profile, app version, date, capture
command, and known limitations. Do not add cropped atmospheric images that hide
the actual interface state.

## Review Use

Product review starts with the screenshots before reading raw markdown. The
reviewer should ask whether the first-run path, coach naming, prompt chips,
streaming response, preview reveal, and report path are visible enough for a
workshop member. If an intended behavior cannot be seen in screenshot/GIF
evidence, it should not count as release-ready unless a manual checklist names
the gap explicitly.

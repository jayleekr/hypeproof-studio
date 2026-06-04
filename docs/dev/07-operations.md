---
title: Studio Operations
product: studio
doc_type: operations
status: canonical
owner: core
version: 0.1.5
last_reviewed: 2026-05-22
audience: operators
source_paths:
  - scripts/install-mac.sh
  - scripts/verify-prod.sh
  - worker
quality_gates:
  - setup-documented
  - failure-paths-documented
  - source-paths-exist
---

# Studio Operations

## Local Setup

Maintainers work from macOS for full Studio build and Electron verification.
Worker-only work can run on other Unix-like environments, but release packaging
is macOS-primary. Use `scripts/check-env.sh` to inspect prerequisites,
`scripts/dev-stack.sh` for local service setup where applicable, and
`scripts/install-mac.sh` for install-path rehearsal. Secrets are never committed;
local examples live as example files or documented environment names.

## Workshop Operation

Before a workshop, confirm cohort profile, token issuer path, install artifact,
participant install guide, and rehearsal smoke. During a workshop, the operator
watches token failures, streaming latency, preview errors, and report-problem
submissions. After a workshop, capture screenshots/GIFs for `docs/dev/08-ux-
evidence.md`, update the release checklist with observed issues, and promote any
new recurring failure into a requirement or test.

## Incident Response

For auth incidents, classify whether the problem is expired token, inactive
session, roster mismatch, or Worker outage. For preview incidents, check CSP,
iframe sandbox, generated HTML extraction, and workspace write permissions. For
release incidents, check branding verification and whether the member installed
the intended binary version. Every incident should end with one of three
outcomes: requirement updated, test added, or release note risk documented.

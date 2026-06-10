---
title: Studio Directory Structure
product: studio
doc_type: directory
status: canonical
owner: core
version: 0.1.5
last_reviewed: 2026-05-22
audience: maintainers
source_paths:
  - extensions
  - worker
  - e2e
  - scripts
quality_gates:
  - directory-tree-present
  - ownership-boundaries
  - source-paths-exist
---

# Studio Directory Structure

## Tree

```text
hypeproof-studio/
├── extensions/hypeproof-chat/       # built-in VS Code extension
│   ├── src/                         # activation, panels, proxy, helpers
│   └── webview-ui/                  # chat panel UI bundle
├── worker/                          # Cloudflare Worker API for Studio
│   ├── src/routes/                  # chat, trace, report, admin, issuer
│   ├── src/lib/                     # token, SSE, model, storage helpers
│   ├── src/profiles/                # cohort profile definitions
│   └── test/                        # Worker smoke tests
├── e2e/                             # Playwright Electron app tests
├── tests/rehearsal/                 # live Worker contract tests
├── scripts/                         # build, install, verify, deploy scripts
├── docs/                            # product, workshop, release docs
├── vscodium-base/                   # upstream app base and branding inputs
└── docs/dev/                        # canonical developer docs contract
```

## Ownership Boundaries

Extension code owns local IDE behavior. Worker code owns network contracts and
cohort policy. `vscodium-base` should be treated as upstream-heavy surface:
change it only for explicit product override or build integration work. Scripts
under `scripts/` are release-critical because they create the installable app
and verify branding integrity. Tests under `e2e/` should describe user behavior,
not implementation details. Rehearsal tests under `tests/rehearsal/` should
describe live API shape and token lifecycle.

## Change Policy

A PR that edits `extensions/hypeproof-chat/src` must check whether
`docs/studio-requirements.md` and `docs/dev/04-requirements.md` need a matching
update. A PR that edits `worker/src/routes` must also review rehearsal tests. A
PR that edits `scripts/build-all.sh`, `scripts/apply-product-overrides.sh`, or
`scripts/verify-branding.sh` must update release docs because packaging drift is
high-impact for workshop delivery.

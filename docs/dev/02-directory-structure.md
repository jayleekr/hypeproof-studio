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

## Chalk Authoring Placement and Naming

The current [layer plan](../plan/vessel-and-modules.md) and
[product registry](../../products.yaml) define App, Service, Surface, and Module.
The tree above predates Chalk; the following paths extend that map without
creating a new top-level product.

| Path | Ownership |
|---|---|
| chalk/src/ui/ | Instructor web pages, including proposed authoring UI |
| chalk/src/routes/ | Instructor reads and authorized Service forwarding |
| chalk/src/lib/ | Pure instructor-surface helpers |
| chalk/src/shared.ts | Existing explicit Service import boundary |
| chalk/test/ | Surface/auth/board contract tests |
| worker/src/lib/modules.ts | Existing module envelope and resolution |
| worker/migrations/ | Existing migration location; inspect schema tooling before adding files |
| docs/requirements/chalk-authoring.md | Proposed authoring behavior and acceptance |
| docs/testing/chalk-authoring.md | Linked test requirements and delivery gates |

Use kebab-case for new documentation and Chalk/Worker feature files, matching
adjacent files. Preserve existing extension camelCase and component PascalCase;
do not rename old files for consistency alone. Test files follow the owning
package's existing .test.mjs or .smoke.mjs convention. Keep fixtures alongside
the relevant tests and synthetic. Do not introduce a generic shared/ or modules/
root just for this feature; new top-level products follow registry admission.

Module data must reuse or explicitly evolve hps-module/1. Service policy flags
are not editable curriculum data. The proposed session-design content schema
needs a consumer and a drift-lock test before it is treated as supported.
